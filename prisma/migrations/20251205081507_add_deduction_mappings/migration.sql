-- AlterTable
ALTER TABLE "VariantRule" ADD COLUMN "deductionMappings" TEXT;

-- AlterTable: Make type nullable for backward compatibility
ALTER TABLE "VariantRule" ALTER COLUMN "type" DROP NOT NULL;

