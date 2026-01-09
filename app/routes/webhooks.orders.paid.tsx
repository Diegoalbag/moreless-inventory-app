import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calculateMultipackInventory } from "../utils/inventory-calculation.server";

interface OrderLineItem {
  variant_id: number;
  quantity: number;
  variant_inventory_management?: string;
}

interface OrderPayload {
  id?: number;
  admin_graphql_api_id?: string;
  line_items?: OrderLineItem[];
  fulfillment_status?: string;
}

/**
 * Webhook handler for orders/paid events.
 * 
 * This handler processes both regular orders and subscription orders.
 * When a subscription billing attempt succeeds, Shopify creates an order
 * which triggers the orders/paid webhook, so this handler automatically
 * processes subscription orders as well.
 * 
 * The handler:
 * 1. Checks if the order was already processed (idempotency)
 * 2. Retrieves fulfillment location from the order
 * 3. Processes line items and applies custom inventory deduction mappings
 * 4. Adjusts inventory quantities based on configured mappings (target variant + multiplier)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, session, topic, payload } = await authenticate.webhook(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  console.log(`Order payload:`, JSON.stringify(payload, null, 2));

  try {
    const order = payload as OrderPayload;
    const orderId = order.id?.toString() || order.admin_graphql_api_id?.split('/').pop() || '';
    
    if (!orderId) {
      console.log("Order ID not found in payload");
      return new Response();
    }

    // Check if order was already processed (idempotency)
    const existing = await db.processedOrder.findUnique({
      where: {
        shop_orderId: {
          shop,
          orderId,
        },
      },
    });

    if (existing) {
      console.log(`Order ${orderId} already processed, skipping`);
      return new Response();
    }

    // Mark order as being processed
    await db.processedOrder.create({
      data: {
        shop,
        orderId,
      },
    });
    
    if (!order.line_items || order.line_items.length === 0) {
      console.log("Order has no line items, skipping");
      return new Response();
    }

    // Get all variant rules for this shop
    const variantRules = await db.variantRule.findMany({
      where: { shop },
    });

    // Create a map for quick lookup
    const rulesMap = new Map(
      variantRules.map((rule) => [rule.variantId, rule])
    );

    // Process each line item
    const inventoryAdjustments: Array<{
      inventoryItemId: string;
      locationId: string;
      delta: number;
    }> = [];

    // Get order details to find fulfillment location
    const orderResponse = await admin.graphql(
      `#graphql
        query getOrder($id: ID!) {
          order(id: $id) {
            id
            fulfillmentOrders(first: 1) {
              edges {
                node {
                  assignedLocation {
                    location {
                      id
                    }
                  }
                  lineItems(first: 10) {
                    edges {
                      node {
                        lineItem {
                          id
                          variant {
                            id
                            inventoryItem {
                              id
                            }
                          }
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          id: order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
        },
      }
    );

    const orderData = await orderResponse.json();
    const fulfillmentOrder = orderData.data?.order?.fulfillmentOrders?.edges?.[0]?.node;
    
    // For subscription orders, fulfillment orders might be SCHEDULED or not yet created
    // Try to get location from fulfillment order first, then fall back to querying locations
    let locationId: string | null = null;
    
    if (fulfillmentOrder?.assignedLocation?.location?.id) {
      locationId = fulfillmentOrder.assignedLocation.location.id;
    } else {
      // Fallback: Get the first active location for the shop
      console.log("No fulfillment location found, trying to get shop locations...");
      const locationsResponse = await admin.graphql(
        `#graphql
          query getLocations {
            locations(first: 1) {
              edges {
                node {
                  id
                  isActive
                }
              }
            }
          }
        `
      );
      
      const locationsData = await locationsResponse.json();
      const location = locationsData.data?.locations?.edges?.[0]?.node;
      
      if (location?.isActive && location.id) {
        locationId = location.id;
        console.log(`Using fallback location: ${locationId}`);
      }
    }
    
    if (!locationId) {
      console.log("No fulfillment location found for order, skipping inventory adjustment");
      console.log("Order data:", JSON.stringify(orderData, null, 2));
      return new Response();
    }

    // Process each line item
    for (const lineItem of order.line_items) {
      // Skip if inventory is not managed by Shopify
      if (lineItem.variant_inventory_management !== "shopify") {
        continue;
      }

      const variantId = `gid://shopify/ProductVariant/${lineItem.variant_id}`;
      const rule = rulesMap.get(variantId);

      if (!rule) {
        // No custom rule, let Shopify handle normally
        continue;
      }

      // Get variant details to find inventory item ID
      const variantResponse = await admin.graphql(
        `#graphql
          query getVariant($id: ID!) {
            productVariant(id: $id) {
              id
              inventoryItem {
                id
              }
            }
          }
        `,
        {
          variables: {
            id: variantId,
          },
        }
      );

      const variantData = await variantResponse.json();
      const inventoryItemId = variantData.data?.productVariant?.inventoryItem?.id;

      if (!inventoryItemId) {
        console.log(`No inventory item found for variant ${variantId}`);
        continue;
      }

      // Check if new deduction mappings format exists
      if (rule.deductionMappings) {
        try {
          const mappings: Array<{ targetVariantId: string; multiplier: number }> = 
            JSON.parse(rule.deductionMappings);
          
          if (Array.isArray(mappings) && mappings.length > 0) {
            // Process each deduction mapping
            for (const mapping of mappings) {
              // Get inventory item ID for the target variant
              const targetVariantResponse = await admin.graphql(
                `#graphql
                  query getVariant($id: ID!) {
                    productVariant(id: $id) {
                      id
                      inventoryItem {
                        id
                      }
                    }
                  }
                `,
                {
                  variables: {
                    id: mapping.targetVariantId,
                  },
                }
              );

              const targetVariantData = await targetVariantResponse.json();
              const targetInventoryItemId = targetVariantData.data?.productVariant?.inventoryItem?.id;

              if (targetInventoryItemId) {
                // Deduct quantity × multiplier from the target variant
                const delta = -(lineItem.quantity * mapping.multiplier);
                inventoryAdjustments.push({
                  inventoryItemId: targetInventoryItemId,
                  locationId,
                  delta,
                });
              } else {
                console.log(`No inventory item found for target variant ${mapping.targetVariantId}`);
              }
            }
            
            // Add back the inventory that Shopify deducted from the ordered variant
            // since we're deducting from the target variants instead
            inventoryAdjustments.push({
              inventoryItemId,
              locationId,
              delta: lineItem.quantity, // Add back what Shopify deducted
            });
          }
        } catch (error) {
          console.error(`Error parsing deduction mappings: ${error}`);
          // Fall back to legacy rule types if parsing fails
          if (rule.type === "multiplier") {
            const multiplier = rule.multiplier || 3;
            const additionalDeduction = multiplier - 1;
            const delta = -(lineItem.quantity * additionalDeduction);
            inventoryAdjustments.push({
              inventoryItemId,
              locationId,
              delta,
            });
          } else if (rule.type === "variety_pack" && rule.varietyPackFlavorIds) {
            try {
              const flavorIds: string[] = JSON.parse(rule.varietyPackFlavorIds);
              for (const flavorId of flavorIds) {
                const flavorResponse = await admin.graphql(
                  `#graphql
                    query getVariant($id: ID!) {
                      productVariant(id: $id) {
                        id
                        inventoryItem {
                          id
                        }
                      }
                    }
                  `,
                  {
                    variables: {
                      id: flavorId,
                    },
                  }
                );
                const flavorData = await flavorResponse.json();
                const flavorInventoryItemId = flavorData.data?.productVariant?.inventoryItem?.id;
                if (flavorInventoryItemId) {
                  inventoryAdjustments.push({
                    inventoryItemId: flavorInventoryItemId,
                    locationId,
                    delta: -lineItem.quantity,
                  });
                }
              }
              inventoryAdjustments.push({
                inventoryItemId,
                locationId,
                delta: lineItem.quantity,
              });
            } catch (parseError) {
              console.error(`Error parsing variety pack flavor IDs: ${parseError}`);
            }
          }
        }
      } else if (rule.type === "multiplier") {
        // Legacy multiplier rule support
        const multiplier = rule.multiplier || 3;
        const additionalDeduction = multiplier - 1;
        const delta = -(lineItem.quantity * additionalDeduction);
        inventoryAdjustments.push({
          inventoryItemId,
          locationId,
          delta,
        });
      } else if (rule.type === "variety_pack" && rule.varietyPackFlavorIds) {
        // Legacy variety pack rule support
        try {
          const flavorIds: string[] = JSON.parse(rule.varietyPackFlavorIds);
          for (const flavorId of flavorIds) {
            const flavorResponse = await admin.graphql(
              `#graphql
                query getVariant($id: ID!) {
                  productVariant(id: $id) {
                    id
                    inventoryItem {
                      id
                    }
                  }
                }
              `,
              {
                variables: {
                  id: flavorId,
                },
              }
            );
            const flavorData = await flavorResponse.json();
            const flavorInventoryItemId = flavorData.data?.productVariant?.inventoryItem?.id;
            if (flavorInventoryItemId) {
              inventoryAdjustments.push({
                inventoryItemId: flavorInventoryItemId,
                locationId,
                delta: -lineItem.quantity,
              });
            }
          }
          inventoryAdjustments.push({
            inventoryItemId,
            locationId,
            delta: lineItem.quantity,
          });
        } catch (parseError) {
          console.error(`Error parsing variety pack flavor IDs: ${parseError}`);
        }
      }
    }

    // Apply all inventory adjustments
    if (inventoryAdjustments.length > 0) {
      // Consolidate adjustments by inventoryItemId + locationId to avoid duplicates
      const consolidatedAdjustments = new Map<string, { inventoryItemId: string; locationId: string; delta: number }>();
      
      for (const adj of inventoryAdjustments) {
        const key = `${adj.inventoryItemId}:${adj.locationId}`;
        const existing = consolidatedAdjustments.get(key);
        if (existing) {
          existing.delta += adj.delta;
        } else {
          consolidatedAdjustments.set(key, { ...adj });
        }
      }
      
      const uniqueAdjustments = Array.from(consolidatedAdjustments.values());
      
      // Get current quantities first
      const quantityUpdates = await Promise.all(
        uniqueAdjustments.map(async (adj) => {
          // Query inventory level using the inventory item and location
          const levelResponse = await admin.graphql(
            `#graphql
              query getInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
                inventoryItem(id: $inventoryItemId) {
                  inventoryLevel(locationId: $locationId) {
                    id
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            `,
            {
              variables: {
                inventoryItemId: adj.inventoryItemId,
                locationId: adj.locationId,
              },
            }
          );

          const levelData = await levelResponse.json();
          const currentQuantity = levelData.data?.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity || 0;
          const newQuantity = Math.max(0, currentQuantity + adj.delta); // delta is negative, so this subtracts

          return {
            inventoryItemId: adj.inventoryItemId,
            locationId: adj.locationId,
            quantity: newQuantity,
            compareQuantity: currentQuantity,
          };
        })
      );

      // Use inventorySetQuantities to set the new quantities
      const setQuantitiesResponse = await admin.graphql(
        `#graphql
          mutation setInventoryQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup {
                id
                reason
                changes {
                  name
                  delta
                  quantityAfterChange
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            input: {
              name: "available",
              reason: "correction",
              referenceDocumentUri: order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
              quantities: quantityUpdates,
            },
          },
        }
      );

      const setQuantitiesData = await setQuantitiesResponse.json();
      
      if (setQuantitiesData.data?.inventorySetQuantities?.userErrors?.length > 0) {
        console.error("Inventory adjustment errors:", setQuantitiesData.data.inventorySetQuantities.userErrors);
      } else {
        console.log(`Successfully adjusted inventory for order ${orderId}`);
      }
    }

    // Calculate and update multipack inventory after processing order
    try {
      await calculateMultipackInventory(admin, shop);
    } catch (error) {
      console.error(`Error calculating multipack inventory after order processing: ${error}`);
      // Don't fail the webhook if multipack calculation fails
    }

    return new Response();
  } catch (error) {
    console.error(`Error processing order webhook: ${error}`);
    return new Response("Internal Server Error", { status: 500 });
  }
};

