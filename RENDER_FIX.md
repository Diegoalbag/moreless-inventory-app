# Fix for Render Database Migration Error

## Problem
The error occurs because the database tables don't exist yet. The migrations were created for SQLite, but we're using PostgreSQL on Render.

## Solution Applied

1. **Updated `migration_lock.toml`** - Changed provider from `sqlite` to `postgresql`
2. **Updated `package.json`** - Changed `setup` script to use `prisma db push` instead of `prisma migrate deploy`
   - `prisma db push` syncs the schema directly to the database (bypassing old SQLite migrations)
   - `--accept-data-loss` flag is safe since this is a fresh database

## What Happens Now

When Render starts your app:
1. `npm run docker-start` runs
2. Which runs `npm run setup`
3. Which runs `prisma generate && prisma db push --accept-data-loss`
4. This creates all tables (Session, VariantRule, ProcessedOrder) in PostgreSQL

## Next Steps

1. **Commit and push these changes:**
   ```bash
   git add .
   git commit -m "Fix database migrations for PostgreSQL on Render"
   git push origin main
   ```

2. **Redeploy on Render:**
   - Render will automatically redeploy when you push
   - Or manually trigger a deploy in the Render dashboard

3. **Check the logs:**
   - In Render dashboard, check the "Logs" tab
   - You should see "Prisma schema loaded from prisma/schema.prisma"
   - And "Database synchronized successfully"

## Alternative: Create Fresh Migrations (Optional)

If you want to use proper migrations instead of `db push`, you can:

1. Delete the old migrations folder
2. Run: `npx prisma migrate dev --name init_postgresql`
3. This creates fresh PostgreSQL migrations
4. Then change `setup` script back to `prisma migrate deploy`

But `db push` is simpler and works fine for this use case.

