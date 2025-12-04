-- CreateTable
CREATE TABLE "ProcessedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_idx" ON "ProcessedOrder"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedOrder_shop_orderId_key" ON "ProcessedOrder"("shop", "orderId");
