-- CreateTable
CREATE TABLE "VariantRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "multiplier" INTEGER,
    "varietyPackFlavorIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "VariantRule_shop_idx" ON "VariantRule"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "VariantRule_shop_variantId_key" ON "VariantRule"("shop", "variantId");
