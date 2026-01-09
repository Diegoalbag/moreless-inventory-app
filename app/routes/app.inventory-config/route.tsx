import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import db from "../../db.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { calculateMultipackInventory } from "../../utils/inventory-calculation.server";

interface Product {
  id: string;
  title: string;
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        sku: string | null;
        price: string;
      };
    }>;
  };
}

interface DeductionMapping {
  targetVariantId: string;
  multiplier: number;
}

interface VariantRule {
  id: string;
  variantId: string;
  type: string | null;
  multiplier: number | null;
  varietyPackFlavorIds: string | null;
  deductionMappings: string | null; // JSON array of DeductionMapping
  calculateInventoryForSelfMapping: boolean; // Toggle to calculate inventory when variant maps to itself
}

interface LoaderData {
  products: Product[];
  variantRules: VariantRule[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  // Fetch all products with variants
  const productsResponse = await admin.graphql(
    `#graphql
      query getProducts {
        products(first: 250, query: "status:active") {
          edges {
            node {
              id
              title
              status
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                  }
                }
              }
            }
          }
        }
      }
    `
  );

  const productsData = await productsResponse.json() as {
    data?: {
      products?: {
        edges?: Array<{ node: Product }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  
  // Check for GraphQL errors
  if (productsData.errors && productsData.errors.length > 0) {
    console.error("GraphQL errors fetching products:", productsData.errors);
    throw new Response(
      `Failed to fetch products: ${productsData.errors.map((e) => e.message).join(", ")}`,
      { status: 500 }
    );
  }

  // Check if data exists
  if (!productsData.data) {
    console.error("No data in products response:", productsData);
    throw new Response("Failed to fetch products: No data returned", { status: 500 });
  }

  const products: Product[] =
    productsData.data?.products?.edges?.map((edge) => edge.node) || [];
  
  console.log(`Loaded ${products.length} products for shop ${session.shop}`);
  if (products.length > 0) {
    console.log("First product sample:", JSON.stringify(products[0], null, 2));
  }

  // Fetch existing variant rules
  const variantRules = await db.variantRule.findMany({
    where: { shop: session.shop },
  });

  return {
    products,
    variantRules,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const formData = await request.formData();
  const action = formData.get("action");

  if (action === "save") {
    const variantId = formData.get("variantId") as string;
    const deductionMappingsJson = formData.get("deductionMappings") as string;

    if (!variantId) {
      return { error: "Variant ID is required" };
    }

    // Validate deduction mappings
    if (!deductionMappingsJson) {
      return { error: "Deduction mappings are required" };
    }

    let deductionMappings: Array<{ targetVariantId: string; multiplier: number }>;
    try {
      deductionMappings = JSON.parse(deductionMappingsJson);
      if (!Array.isArray(deductionMappings) || deductionMappings.length === 0) {
        return { error: "At least one deduction mapping is required" };
      }
      for (const mapping of deductionMappings) {
        if (!mapping.targetVariantId || !mapping.multiplier || mapping.multiplier < 1) {
          return { error: "Each mapping must have a valid target variant and multiplier >= 1" };
        }
      }
    } catch (error) {
      return { error: "Invalid deduction mappings format" };
    }

    const calculateInventoryForSelfMapping = formData.get("calculateInventoryForSelfMapping") === "true";

    // Upsert the variant rule
    await db.variantRule.upsert({
      where: {
        shop_variantId: {
          shop: session.shop,
          variantId,
        },
      },
      create: {
        shop: session.shop,
        variantId,
        deductionMappings: deductionMappingsJson,
        calculateInventoryForSelfMapping,
      },
      update: {
        deductionMappings: deductionMappingsJson,
        calculateInventoryForSelfMapping,
      },
    });

    // Calculate and update multipack inventory after saving rule
    try {
      await calculateMultipackInventory(admin, session.shop);
    } catch (error) {
      console.error(`Error calculating multipack inventory after rule save: ${error}`);
      // Don't fail the action if multipack calculation fails
    }

    return { success: true };
  } else if (action === "delete") {
    const variantId = formData.get("variantId") as string;

    if (!variantId) {
      return { error: "Variant ID is required" };
    }

    await db.variantRule.deleteMany({
      where: {
        shop: session.shop,
        variantId,
      },
    });

    // Calculate and update multipack inventory after deleting rule
    try {
      await calculateMultipackInventory(admin, session.shop);
    } catch (error) {
      console.error(`Error calculating multipack inventory after rule delete: ${error}`);
      // Don't fail the action if multipack calculation fails
    }

    return { success: true };
  }

  return { error: "Invalid action" };
};

export default function InventoryConfig() {
  const { products, variantRules } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  
  // Debug logging
  useEffect(() => {
    console.log("Products in component:", products);
    console.log("Products count:", products?.length || 0);
    if (products && products.length > 0) {
      console.log("First product:", products[0]);
    }
  }, [products]);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [deductionMappings, setDeductionMappings] = useState<DeductionMapping[]>([]);
  const [calculateInventoryForSelfMapping, setCalculateInventoryForSelfMapping] = useState<boolean>(false);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Configuration saved successfully");
      setEditingVariantId(null);
      // Reload the page to refresh data
      window.location.reload();
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const selectedProduct = products.find((p) => p.id === selectedProductId);
  const allVariants = products.flatMap((p) =>
    p.variants.edges.map((edge) => ({
      ...edge.node,
      productTitle: p.title,
      productId: p.id,
    }))
  );
  
  // Get variants from the same product as the variant being edited
  const getSameProductVariants = (variantId: string) => {
    const variant = allVariants.find((v) => v.id === variantId);
    if (!variant) return allVariants;
    return allVariants.filter((v) => v.productId === variant.productId);
  };

  const getRuleForVariant = (variantId: string) => {
    return variantRules.find((r) => r.variantId === variantId);
  };

  const startEditing = (variantId: string) => {
    const rule = getRuleForVariant(variantId);
    setEditingVariantId(variantId);
    if (rule && rule.deductionMappings) {
      try {
        const mappings = JSON.parse(rule.deductionMappings);
        if (Array.isArray(mappings)) {
          setDeductionMappings(mappings);
        } else {
          setDeductionMappings([]);
        }
      } catch {
        setDeductionMappings([]);
      }
    } else {
      setDeductionMappings([]);
    }
    // Load toggle value
    setCalculateInventoryForSelfMapping(rule?.calculateInventoryForSelfMapping || false);
  };

  const addMapping = () => {
    setDeductionMappings([
      ...deductionMappings,
      { targetVariantId: "", multiplier: 1 },
    ]);
  };

  const updateMapping = (index: number, field: keyof DeductionMapping, value: string | number) => {
    const updated = [...deductionMappings];
    updated[index] = { ...updated[index], [field]: value };
    setDeductionMappings(updated);
  };

  const removeMapping = (index: number) => {
    setDeductionMappings(deductionMappings.filter((_, i) => i !== index));
  };

  const handleSave = (variantId: string) => {
    // Validate mappings
    if (deductionMappings.length === 0) {
      shopify.toast.show("Please add at least one deduction mapping", { isError: true });
      return;
    }

    for (const mapping of deductionMappings) {
      if (!mapping.targetVariantId) {
        shopify.toast.show("Please select a target variant for all mappings", { isError: true });
        return;
      }
      if (mapping.multiplier < 1) {
        shopify.toast.show("Multiplier must be at least 1", { isError: true });
        return;
      }
    }

    const formData = new FormData();
    formData.append("action", "save");
    formData.append("variantId", variantId);
    formData.append("deductionMappings", JSON.stringify(deductionMappings));
    formData.append("calculateInventoryForSelfMapping", calculateInventoryForSelfMapping.toString());
    fetcher.submit(formData, { method: "POST" });
  };

  const handleDelete = (variantId: string) => {
    if (confirm("Are you sure you want to delete this rule?")) {
      const formData = new FormData();
      formData.append("action", "delete");
      formData.append("variantId", variantId);
      fetcher.submit(formData, { method: "POST" });
    }
  };

  return (
    <s-page heading="Inventory Configuration">
      <s-section heading="Configure Custom Inventory Deduction Rules">
        <s-paragraph>
          Set up custom inventory deduction mappings for your product variants. 
          For each variant, you can specify which other variants to deduct inventory from 
          and how much (multiplier) to deduct when this variant is ordered.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              {products && products.length > 0 && (
                <s-text tone="subdued">
                  Found {products.length} product{products.length !== 1 ? 's' : ''}
                </s-text>
              )}
              <s-select
                id="product-select"
                label="Select Product"
                value={selectedProductId}
                onChange={(e: any) => {
                  setSelectedProductId(e.currentTarget.value);
                  setEditingVariantId(null);
                }}
              >
                <s-option value="">-- Select a product --</s-option>
                {products && products.length > 0 ? (
                  products.map((product) => (
                    <s-option key={product.id} value={product.id}>
                      {product.title || `Product ${product.id}`}
                    </s-option>
                  ))
                ) : (
                  <s-option value="" disabled>
                    No products found
                  </s-option>
                )}
              </s-select>
              {(!products || products.length === 0) && (
                <s-text tone="subdued">
                  No products found in your store. Please create products in your Shopify admin first.
                </s-text>
              )}
            </s-stack>
          </s-box>

          {selectedProduct && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>Variants for {selectedProduct.title}</s-heading>
              <s-stack direction="block" gap="base">
                {selectedProduct.variants.edges.map((edge) => {
                  const variant = edge.node;
                  const rule = getRuleForVariant(variant.id);
                  const isEditing = editingVariantId === variant.id;

                  return (
                    <s-box
                      key={variant.id}
                      padding="base"
                      borderWidth="base"
                      borderRadius="base"
                      background={rule ? "subdued" : undefined}
                    >
                      <s-stack direction="block" gap="base">
                        <s-stack direction="inline" gap="base" alignment="space-between">
                          <div>
                            <s-text emphasis="strong">{variant.title || "Default"}</s-text>
                            {variant.sku && (
                              <s-text tone="subdued"> (SKU: {variant.sku})</s-text>
                            )}
                            {rule && rule.deductionMappings && (() => {
                              try {
                                const mappings = JSON.parse(rule.deductionMappings);
                                if (Array.isArray(mappings) && mappings.length > 0) {
                                  return (
                                    <s-text tone="success">
                                      {" "}
                                      - {mappings.length} mapping{mappings.length !== 1 ? 's' : ''} configured
                                    </s-text>
                                  );
                                }
                              } catch {
                                return null;
                              }
                            })()}
                            {rule && !rule.deductionMappings && rule.type && (
                              <s-text tone="subdued">
                                {" "}
                                - Legacy rule: {rule.type}
                              </s-text>
                            )}
                          </div>
                          {!isEditing && (
                            <s-stack direction="inline" gap="base">
                              <s-button
                                variant="secondary"
                                onClick={() => startEditing(variant.id)}
                              >
                                {rule ? "Edit" : "Configure"}
                              </s-button>
                              {rule && (
                                <s-button
                                  variant="tertiary"
                                  onClick={() => handleDelete(variant.id)}
                                >
                                  Delete
                                </s-button>
                              )}
                            </s-stack>
                          )}
                        </s-stack>

                        {isEditing && (
                          <s-box
                            padding="base"
                            borderWidth="base"
                            borderRadius="base"
                            background="subdued"
                          >
                            <s-stack direction="block" gap="base">
                              <s-heading>Deduction Mappings</s-heading>
                              <s-text tone="subdued">
                                Configure which variants to deduct inventory from and how much when this variant is ordered.
                              </s-text>

                              {deductionMappings.map((mapping, index) => (
                                <s-box
                                  key={index}
                                  padding="base"
                                  borderWidth="base"
                                  borderRadius="base"
                                >
                                  <s-stack direction="block" gap="base">
                                    <s-stack direction="inline" gap="base" alignment="space-between">
                                      <s-text emphasis="strong">Mapping {index + 1}</s-text>
                                      <s-button
                                        variant="tertiary"
                                        onClick={() => removeMapping(index)}
                                      >
                                        Remove
                                      </s-button>
                                    </s-stack>
                                    <s-select
                                      label="Target Variant"
                                      value={mapping.targetVariantId}
                                      onChange={(e: any) =>
                                        updateMapping(index, "targetVariantId", e.currentTarget.value)
                                      }
                                    >
                                      <s-option value="">-- Select variant --</s-option>
                                      {getSameProductVariants(variant.id).map((v) => (
                                        <s-option key={v.id} value={v.id}>
                                          {v.title || "Default"}
                                          {v.sku && ` (${v.sku})`}
                                        </s-option>
                                      ))}
                                    </s-select>
                                    <s-text-field
                                      label="Multiplier"
                                      value={mapping.multiplier.toString()}
                                      onChange={(e: any) => {
                                        const value = parseInt(e.currentTarget.value) || 1;
                                        updateMapping(
                                          index,
                                          "multiplier",
                                          Math.max(1, value) // Ensure minimum of 1
                                        );
                                      }}
                                      details="Enter how many units to deduct from the selected variant when 1 unit of this variant is ordered"
                                    />
                                    {mapping.targetVariantId && (() => {
                                      const targetVariant = getSameProductVariants(variant.id).find(
                                        (v) => v.id === mapping.targetVariantId
                                      );
                                      const targetVariantName = targetVariant?.title || "selected variant";
                                      return (
                                        <s-text tone="subdued">
                                          When 1 unit of {variant.title || "this variant"} is ordered, {mapping.multiplier} unit{mapping.multiplier !== 1 ? 's' : ''} will be deducted from {targetVariantName}.
                                        </s-text>
                                      );
                                    })()}
                                  </s-stack>
                                </s-box>
                              ))}

                              <s-button
                                variant="secondary"
                                onClick={addMapping}
                              >
                                Add Mapping
                              </s-button>

                              {/* Toggle: Only show if ALL mappings are to different variants (none point to itself) */}
                              {(() => {
                                const allMappingsToOtherVariants = deductionMappings.every(
                                  (mapping) => mapping.targetVariantId !== variant.id
                                );
                                
                                return allMappingsToOtherVariants && deductionMappings.length > 0 ? (
                                  <s-box
                                    padding="base"
                                    borderWidth="base"
                                    borderRadius="base"
                                    background="subdued"
                                  >
                                    <s-stack direction="block" gap="base">
                                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                                        <input
                                          type="checkbox"
                                          checked={calculateInventoryForSelfMapping}
                                          onChange={(e) => setCalculateInventoryForSelfMapping(e.currentTarget.checked)}
                                        />
                                        <s-text>
                                          Auto-calculate inventory from source variants
                                        </s-text>
                                      </label>
                                      <s-text tone="subdued">
                                        When enabled, this variant&apos;s inventory will be automatically calculated as the minimum number of complete bundles that can be made from the source variants above. When disabled, the variant will keep its actual inventory and won&apos;t be updated automatically.
                                      </s-text>
                                    </s-stack>
                                  </s-box>
                                ) : null;
                              })()}

                              <s-stack direction="inline" gap="base">
                                <s-button 
                                  variant="primary"
                                  onClick={() => handleSave(variant.id)}
                                  loading={fetcher.state === "submitting"}
                                > 
                                  Save
                                </s-button>
                                <s-button
                                  variant="secondary"
                                  onClick={() => setEditingVariantId(null)}
                                >
                                  Cancel
                                </s-button>
                              </s-stack>
                            </s-stack>
                          </s-box>
                        )}
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

