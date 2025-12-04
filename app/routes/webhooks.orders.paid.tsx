import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, session, topic, payload } = await authenticate.webhook(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

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
    
    if (!fulfillmentOrder?.assignedLocation?.location?.id) {
      console.log("No fulfillment location found for order, skipping inventory adjustment");
      return new Response();
    }

    const locationId = fulfillmentOrder.assignedLocation.location.id;

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

      if (rule.type === "multiplier") {
        // For multiplier rules (3-pack variants), deduct quantity × multiplier
        // Shopify already deducted 1 unit per quantity, so we need to deduct (multiplier - 1) more
        const multiplier = rule.multiplier || 3;
        const additionalDeduction = multiplier - 1; // e.g., if multiplier is 3, deduct 2 more (since 1 was already deducted)
        const delta = -(lineItem.quantity * additionalDeduction);
        
        inventoryAdjustments.push({
          inventoryItemId,
          locationId,
          delta,
        });
      } else if (rule.type === "variety_pack") {
        // For variety pack, deduct 1 from each flavor variant
        if (rule.varietyPackFlavorIds) {
          try {
            const flavorIds: string[] = JSON.parse(rule.varietyPackFlavorIds);
            
            for (const flavorId of flavorIds) {
              // Get inventory item ID for each flavor variant
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
                // Deduct 1 unit per variety pack ordered from each flavor variant
                // Shopify already deducted 1 from the variety pack variant itself,
                // so we need to add that back and deduct from flavors instead
                inventoryAdjustments.push({
                  inventoryItemId: flavorInventoryItemId,
                  locationId,
                  delta: -lineItem.quantity,
                });
              }
            }
            
            // Add back the inventory that Shopify deducted from the variety pack variant
            // since we're deducting from the individual flavors instead
            inventoryAdjustments.push({
              inventoryItemId,
              locationId,
              delta: lineItem.quantity, // Add back what Shopify deducted
            });
          } catch (error) {
            console.error(`Error parsing variety pack flavor IDs: ${error}`);
          }
        }
      }
    }

    // Apply all inventory adjustments
    if (inventoryAdjustments.length > 0) {
      // Get current quantities first
      const quantityUpdates = await Promise.all(
        inventoryAdjustments.map(async (adj) => {
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

    return new Response();
  } catch (error) {
    console.error(`Error processing order webhook: ${error}`);
    return new Response("Internal Server Error", { status: 500 });
  }
};

