-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderNumber" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderSequence" (
    "weekId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 999,

    CONSTRAINT "OrderSequence_pkey" PRIMARY KEY ("weekId")
);
