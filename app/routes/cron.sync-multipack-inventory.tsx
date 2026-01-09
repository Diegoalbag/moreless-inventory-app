import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { calculateMultipackInventory } from "../utils/inventory-calculation.server";
import { sessionStorage } from "../shopify.server";
import { apiVersion } from "../shopify.server";
import { shopifyApi } from "@shopify/shopify-api";

/**
 * Cron job endpoint to sync multipack inventory for all shops
 * 
 * This endpoint should be called periodically (e.g., daily) to ensure
 * multipack inventory stays in sync with source variant inventory.
 * 
 * Authentication: Uses a shared secret from environment variable CRON_SECRET
 * or can be called without auth in development (not recommended for production)
 * 
 * Usage: GET /cron/sync-multipack-inventory?secret=YOUR_CRON_SECRET
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // In production, require a secret to prevent unauthorized access
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = new URL(request.url).searchParams.get("secret");

  if (process.env.NODE_ENV === "production") {
    if (!cronSecret || providedSecret !== cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    console.log("Starting scheduled multipack inventory sync...");

    // Get all unique shops that have variant rules
    const shops = await db.variantRule.findMany({
      select: {
        shop: true,
      },
      distinct: ["shop"],
    });

    const uniqueShops = Array.from(new Set(shops.map((s) => s.shop)));

    console.log(`Found ${uniqueShops.length} shops to process`);

    const results: Array<{ shop: string; success: boolean; error?: string }> = [];

    // Process each shop
    for (const shop of uniqueShops) {
      try {
        // Get a session for this shop to authenticate GraphQL requests
        const sessions = await sessionStorage.findSessionsByShop(shop);

        if (sessions.length === 0) {
          console.log(`No active session found for shop ${shop}, skipping`);
          results.push({ shop, success: false, error: "No active session" });
          continue;
        }

        // Use the first available session (prefer online sessions)
        const session =
          sessions.find((s) => s.isOnline) || sessions[0];

        if (!session.accessToken) {
          console.log(`No access token for shop ${shop}, skipping`);
          results.push({ shop, success: false, error: "No access token" });
          continue;
        }

        // Create an admin GraphQL client from the session
        // Initialize Shopify API and create GraphQL client
        const shopifyApiInstance = shopifyApi({
          apiKey: process.env.SHOPIFY_API_KEY || "",
          apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
          apiVersion: apiVersion,
          scopes: process.env.SCOPES?.split(",") || [],
          hostName: process.env.SHOPIFY_APP_URL
            ? new URL(process.env.SHOPIFY_APP_URL).hostname
            : "localhost",
        });

        const admin = new shopifyApiInstance.clients.Graphql({ session });

        console.log(`Processing shop: ${shop}`);

        // Calculate multipack inventory for this shop
        await calculateMultipackInventory(admin, shop);

        results.push({ shop, success: true });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`Error processing shop ${shop}:`, error);
        results.push({ shop, success: false, error: errorMessage });
        // Continue with next shop
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return new Response(
      JSON.stringify({
        success: true,
        shopsProcessed: uniqueShops.length,
        successful,
        failed,
        results,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error in scheduled multipack inventory sync:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Internal server error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};

