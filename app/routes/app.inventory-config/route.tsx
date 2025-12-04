import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useFetcher, Form } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import db from "../../db.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

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

interface VariantRule {
  id: string;
  variantId: string;
  type: string;
  multiplier: number | null;
  varietyPackFlavorIds: string | null;
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
    const type = formData.get("type") as string;
    const multiplier = formData.get("multiplier")
      ? parseInt(formData.get("multiplier") as string)
      : null;
    const varietyPackFlavorIds = formData.get("varietyPackFlavorIds") as string;

    if (!variantId || !type) {
      return { error: "Variant ID and type are required" };
    }

    // Validate variety pack flavor IDs if type is variety_pack
    if (type === "variety_pack" && varietyPackFlavorIds) {
      try {
        const flavorIds = JSON.parse(varietyPackFlavorIds);
        if (!Array.isArray(flavorIds) || flavorIds.length !== 3) {
          return { error: "Variety pack must have exactly 3 flavor variants" };
        }
      } catch (error) {
        return { error: "Invalid variety pack flavor IDs format" };
      }
    }

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
        type,
        multiplier,
        varietyPackFlavorIds: varietyPackFlavorIds || null,
      },
      update: {
        type,
        multiplier,
        varietyPackFlavorIds: varietyPackFlavorIds || null,
      },
    });

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
  const [ruleType, setRuleType] = useState<"multiplier" | "variety_pack">("multiplier");
  const [multiplier, setMultiplier] = useState<number>(3);
  const [selectedFlavorIds, setSelectedFlavorIds] = useState<string[]>([]);

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
    }))
  );

  const getRuleForVariant = (variantId: string) => {
    return variantRules.find((r) => r.variantId === variantId);
  };

  const startEditing = (variantId: string) => {
    const rule = getRuleForVariant(variantId);
    setEditingVariantId(variantId);
    if (rule) {
      setRuleType(rule.type as "multiplier" | "variety_pack");
      setMultiplier(rule.multiplier || 3);
      if (rule.varietyPackFlavorIds) {
        try {
          setSelectedFlavorIds(JSON.parse(rule.varietyPackFlavorIds));
        } catch {
          setSelectedFlavorIds([]);
        }
      } else {
        setSelectedFlavorIds([]);
      }
    } else {
      setRuleType("multiplier");
      setMultiplier(3);
      setSelectedFlavorIds([]);
    }
  };

  const handleSave = (variantId: string) => {
    const formData = new FormData();
    formData.append("action", "save");
    formData.append("variantId", variantId);
    formData.append("type", ruleType);
    if (ruleType === "multiplier") {
      formData.append("multiplier", multiplier.toString());
    } else {
      formData.append("varietyPackFlavorIds", JSON.stringify(selectedFlavorIds));
    }
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
          Set up custom inventory deduction rules for your product variants. For
          3-pack variants, specify a multiplier. For variety packs, select the
          three flavor variants that should be deducted.
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
                            {rule && (
                              <s-text tone="success">
                                {" "}
                                - {rule.type === "multiplier"
                                  ? `Multiplier: ${rule.multiplier}x`
                                  : "Variety Pack"}
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
                              <s-label>Rule Type</s-label>
                              <s-stack direction="inline" gap="base">
                                <s-radio
                                  name={`type-${variant.id}`}
                                  value="multiplier"
                                  checked={ruleType === "multiplier"}
                                  onChange={() => setRuleType("multiplier")}
                                >
                                  Multiplier (3-pack)
                                </s-radio>
                                <s-radio
                                  name={`type-${variant.id}`}
                                  value="variety_pack"
                                  checked={ruleType === "variety_pack"}
                                  onChange={() => setRuleType("variety_pack")}
                                >
                                  Variety Pack
                                </s-radio>
                              </s-stack>

                              {ruleType === "multiplier" && (
                                <div>
                                  <s-label for={`multiplier-${variant.id}`}>
                                    Multiplier
                                  </s-label>
                                  <s-textfield
                                    id={`multiplier-${variant.id}`}
                                    type="number"
                                    value={multiplier.toString()}
                                    onChange={(e: any) =>
                                      setMultiplier(parseInt(e.target.value) || 3)
                                    }
                                    min="1"
                                  />
                                  <s-text tone="subdued">
                                    When 1 unit is ordered, {multiplier} units will be
                                    deducted from inventory.
                                  </s-text>
                                </div>
                              )}

                              {ruleType === "variety_pack" && (
                                <div>
                                  <s-label>Select 3 Flavor Variants</s-label>
                                  <s-text tone="subdued">
                                    Select exactly 3 variants. When 1 variety pack is
                                    ordered, 1 unit will be deducted from each selected
                                    flavor.
                                  </s-text>
                                  <s-stack direction="block" gap="tight">
                                    {allVariants
                                      .filter((v) => v.id !== variant.id)
                                      .map((v) => (
                                        <s-checkbox
                                          key={v.id}
                                          checked={selectedFlavorIds.includes(v.id)}
                                          onChange={(checked: boolean) => {
                                            if (checked) {
                                              if (selectedFlavorIds.length < 3) {
                                                setSelectedFlavorIds([
                                                  ...selectedFlavorIds,
                                                  v.id,
                                                ]);
                                              }
                                            } else {
                                              setSelectedFlavorIds(
                                                selectedFlavorIds.filter(
                                                  (id) => id !== v.id
                                                )
                                              );
                                            }
                                          }}
                                          disabled={
                                            !selectedFlavorIds.includes(v.id) &&
                                            selectedFlavorIds.length >= 3
                                          }
                                        >
                                          {v.productTitle} - {v.title || "Default"}
                                          {v.sku && ` (${v.sku})`}
                                        </s-checkbox>
                                      ))}
                                  </s-stack>
                                  {selectedFlavorIds.length > 0 && (
                                    <s-text tone="subdued">
                                      Selected: {selectedFlavorIds.length}/3
                                    </s-text>
                                  )}
                                </div>
                              )}

                              <s-stack direction="inline" gap="base">
                                <s-button
                                  variant="primary"
                                  onClick={() => {
                                    if (
                                      ruleType === "variety_pack" &&
                                      selectedFlavorIds.length !== 3
                                    ) {
                                      shopify.toast.show(
                                        "Please select exactly 3 flavor variants",
                                        { isError: true }
                                      );
                                      return;
                                    }
                                    handleSave(variant.id);
                                  }}
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

