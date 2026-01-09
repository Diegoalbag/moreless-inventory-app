import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

interface DeductionMapping {
  targetVariantId: string;
  multiplier: number;
}

interface Location {
  id: string;
  isActive: boolean;
  name: string;
}

/**
 * Get all active locations for a shop
 */
async function getAllActiveLocations(
  admin: AdminApiContext
): Promise<Location[]> {
  const response = await admin.graphql(
    `#graphql
      query getLocations {
        locations(first: 250) {
          edges {
            node {
              id
              isActive
              name
            }
          }
        }
      }
    `
  );

  const data = await response.json();
  const locations =
    data.data?.locations?.edges
      ?.map((edge: { node: Location }) => edge.node)
      .filter((loc: Location) => loc.isActive) || [];

  return locations;
}

/**
 * Get available inventory quantity for a variant at a specific location
 */
async function getVariantInventory(
  admin: AdminApiContext,
  variantId: string,
  locationId: string
): Promise<number> {
  try {
    // First get the variant to find its inventory item
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
    const inventoryItemId =
      variantData.data?.productVariant?.inventoryItem?.id;

    if (!inventoryItemId) {
      console.log(`No inventory item found for variant ${variantId}`);
      return 0;
    }

    // Get inventory level at the location
    const levelResponse = await admin.graphql(
      `#graphql
        query getInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
          inventoryItem(id: $inventoryItemId) {
            inventoryLevel(locationId: $locationId) {
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
          inventoryItemId,
          locationId,
        },
      }
    );

    const levelData = await levelResponse.json();
    const quantity =
      levelData.data?.inventoryItem?.inventoryLevel?.quantities?.[0]
        ?.quantity || 0;

    return quantity;
  } catch (error) {
    console.error(
      `Error getting inventory for variant ${variantId} at location ${locationId}:`,
      error
    );
    return 0;
  }
}

/**
 * Update variant inventory at a specific location
 */
async function updateVariantInventory(
  admin: AdminApiContext,
  variantId: string,
  locationId: string,
  quantity: number
): Promise<boolean> {
  try {
    // Get the variant to find its inventory item
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
    const inventoryItemId =
      variantData.data?.productVariant?.inventoryItem?.id;

    if (!inventoryItemId) {
      console.log(`No inventory item found for variant ${variantId}`);
      return false;
    }

    // Get current quantity
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
          inventoryItemId,
          locationId,
        },
      }
    );

    const levelData = await levelResponse.json();
    const currentQuantity =
      levelData.data?.inventoryItem?.inventoryLevel?.quantities?.[0]
        ?.quantity || 0;

    // Set the new quantity
    const setQuantitiesResponse = await admin.graphql(
      `#graphql
        mutation setInventoryQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              id
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
            quantities: [
              {
                inventoryItemId,
                locationId,
                quantity: Math.max(0, quantity),
                compareQuantity: currentQuantity,
              },
            ],
          },
        },
      }
    );

    const setQuantitiesData = await setQuantitiesResponse.json();

    if (
      setQuantitiesData.data?.inventorySetQuantities?.userErrors?.length > 0
    ) {
      console.error(
        "Inventory update errors:",
        setQuantitiesData.data.inventorySetQuantities.userErrors
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      `Error updating inventory for variant ${variantId} at location ${locationId}:`,
      error
    );
    return false;
  }
}

/**
 * Calculate bundles available for a single variant rule
 * Returns the minimum number of bundles that can be made from all target variants
 */
async function calculateBundlesForVariant(
  admin: AdminApiContext,
  variantId: string,
  deductionMappings: DeductionMapping[],
  locationId: string
): Promise<number> {
  const bundleCounts: number[] = [];

  for (const mapping of deductionMappings) {
    const availableQuantity = await getVariantInventory(
      admin,
      mapping.targetVariantId,
      locationId
    );

    // Calculate how many bundles can be made from this target variant
    // floor(available / multiplier)
    const bundles = Math.floor(availableQuantity / mapping.multiplier);
    bundleCounts.push(bundles);
  }

  // Return the minimum (bottleneck variant)
  if (bundleCounts.length === 0) {
    return 0;
  }

  return Math.min(...bundleCounts);
}

/**
 * Main function to calculate and update multipack inventory for a shop
 * This calculates inventory for all variants with deduction mappings
 */
export async function calculateMultipackInventory(
  admin: AdminApiContext,
  shop: string
): Promise<void> {
  try {
    console.log(`Calculating multipack inventory for shop: ${shop}`);

    // Get all variant rules with deduction mappings for this shop
    const variantRules = await db.variantRule.findMany({
      where: {
        shop,
        deductionMappings: {
          not: null,
        },
      },
    });

    if (variantRules.length === 0) {
      console.log(`No variant rules with deduction mappings found for shop: ${shop}`);
      return;
    }

    // Get all active locations
    const locations = await getAllActiveLocations(admin);

    if (locations.length === 0) {
      console.log(`No active locations found for shop: ${shop}`);
      return;
    }

    // Process each variant rule
    for (const rule of variantRules) {
      if (!rule.deductionMappings) {
        continue;
      }

      let deductionMappings: DeductionMapping[];
      try {
        deductionMappings = JSON.parse(rule.deductionMappings);
        if (!Array.isArray(deductionMappings) || deductionMappings.length === 0) {
          continue;
        }
      } catch (error) {
        console.error(
          `Error parsing deduction mappings for variant ${rule.variantId}:`,
          error
        );
        continue;
      }

      // Check if variant has any mappings to itself
      const hasAnySelfMapping = deductionMappings.some(
        (mapping) => mapping.targetVariantId === rule.variantId
      );

      // Skip calculation if variant maps to itself (either all self-mapping or mixed)
      if (hasAnySelfMapping) {
        console.log(
          `Skipping calculation for variant ${rule.variantId} - has mappings to itself`
        );
        continue;
      }

      // If all mappings are to different variants, check toggle to control calculation
      if (!rule.calculateInventoryForSelfMapping) {
        console.log(
          `Skipping calculation for variant ${rule.variantId} - toggle is disabled`
        );
        continue;
      }
      // Toggle is enabled, proceed with calculation

      // Process each location
      for (const location of locations) {
        try {
          // Calculate how many bundles can be made
          const bundleCount = await calculateBundlesForVariant(
            admin,
            rule.variantId,
            deductionMappings,
            location.id
          );

          // Update the multipack variant inventory
          const success = await updateVariantInventory(
            admin,
            rule.variantId,
            location.id,
            bundleCount
          );

          if (success) {
            console.log(
              `Updated multipack inventory for variant ${rule.variantId} at location ${location.name}: ${bundleCount} bundles`
            );
          } else {
            console.error(
              `Failed to update multipack inventory for variant ${rule.variantId} at location ${location.name}`
            );
          }
        } catch (error) {
          console.error(
            `Error processing variant ${rule.variantId} at location ${location.id}:`,
            error
          );
          // Continue with next location
        }
      }
    }

    console.log(`Completed multipack inventory calculation for shop: ${shop}`);
  } catch (error) {
    console.error(
      `Error calculating multipack inventory for shop ${shop}:`,
      error
    );
    // Don't throw - let callers handle gracefully
  }
}

