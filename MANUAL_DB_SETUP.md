# Manual Database Setup for Render

If you're getting "Session table does not exist" errors, the automatic setup might not be running. Here's how to manually set up the database:

## Option 1: Run Prisma Commands via Render Shell

1. Go to your Render dashboard
2. Click on your web service
3. Go to the "Shell" tab (or use "Manual Deploy" → "Run Command")
4. Run these commands:

```bash
npx prisma generate
npx prisma db push --accept-data-loss
```

## Option 2: Check Render Logs

1. Go to Render dashboard → Your service → Logs
2. Look for the setup script output
3. You should see:
   - "🚀 Starting database setup..."
   - "📦 Generating Prisma client..."
   - "🗄️ Pushing database schema..."
   - "✅ Session table exists and is accessible!"

If you don't see these, the script isn't running.

## Option 3: Verify DATABASE_URL

1. In Render dashboard → Your service → Environment
2. Make sure `DATABASE_URL` is set and linked to your PostgreSQL database
3. It should look like: `postgresql://user:password@host:5432/database`

## Option 4: Create Tables Manually (Last Resort)

If nothing else works, connect to your PostgreSQL database and run:

```sql
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

CREATE TABLE "VariantRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "multiplier" INTEGER,
    "varietyPackFlavorIds" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("shop", "variantId")
);

CREATE INDEX "VariantRule_shop_idx" ON "VariantRule"("shop");

CREATE TABLE "ProcessedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("shop", "orderId")
);

CREATE INDEX "ProcessedOrder_shop_idx" ON "ProcessedOrder"("shop");
```

## Quick Fix: Update Start Command

If the setup script isn't running, you can temporarily change the start command in Render to:

```
npx prisma generate && npx prisma db push --accept-data-loss && npm run start
```

This will run the database setup every time the app starts (slower, but works).

