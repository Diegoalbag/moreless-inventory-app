import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { calculateMultipackInventory } from "../utils/inventory-calculation.server";

interface InventoryLevelPayload {
  inventory_item_id?: number;
  location_id?: number;
  available?: number;
  updated_at?: string;
}

/**
 * Webhook handler for inventory_levels/update events.
 * 
 * This handler updates multipack inventory when source variant inventory changes
 * directly (not via orders). This ensures multipack inventory stays in sync when
 * inventory is manually adjusted, transferred between locations, or updated through
 * other means.
 * 
 * The handler:
 * 1. Authenticates the webhook request
 * 2. Extracts shop and inventory item information from payload
 * 3. Calls calculateMultipackInventory() to update all affected multipack variants
 * 4. Handles errors gracefully (logs but doesn't fail webhook)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, session, topic, payload } = await authenticate.webhook(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  console.log(`Inventory level payload:`, JSON.stringify(payload, null, 2));

  try {
    const inventoryLevel = payload as InventoryLevelPayload;

    // When inventory levels update, we need to recalculate multipack inventory
    // for all variants that use this inventory item as a source
    // The calculateMultipackInventory function will handle finding all relevant variants
    
    console.log(
      `Inventory level updated for item ${inventoryLevel.inventory_item_id} at location ${inventoryLevel.location_id}`
    );

    // Calculate and update multipack inventory for the entire shop
    // This is efficient because we only process variants with deduction mappings
    await calculateMultipackInventory(admin, shop);

    console.log(`Successfully updated multipack inventory after inventory level change for shop ${shop}`);

    return new Response();
  } catch (error) {
    console.error(`Error processing inventory level update webhook: ${error}`);
    // Don't fail the webhook - inventory updates should still succeed
    return new Response();
  }
};

