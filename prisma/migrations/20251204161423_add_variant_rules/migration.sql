-- CreateTable
CREATE TABLE "VariantRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "multiplier" INTEGER,
    "varietyPackFlavorIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VariantRule_shop_idx" ON "VariantRule"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "VariantRule_shop_variantId_key" ON "VariantRule"("shop", "variantId");
