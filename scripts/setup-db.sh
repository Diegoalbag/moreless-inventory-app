#!/bin/sh
set -e

echo "Generating Prisma client..."
npx prisma generate

echo "Pushing database schema..."
npx prisma db push --accept-data-loss --skip-generate

echo "Database setup complete!"

