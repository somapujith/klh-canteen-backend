-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "collectionAt" TIMESTAMP(3),
ADD COLUMN     "guestName" TEXT,
ADD COLUMN     "guestPhone" TEXT,
ADD COLUMN     "guestSessionId" TEXT,
ALTER COLUMN "studentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CollectionWindow" (
    "id" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "kitchen" "Kitchen" NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 20,
    "bookedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionWindow_startAt_idx" ON "CollectionWindow"("startAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionWindow_startAt_kitchen_key" ON "CollectionWindow"("startAt", "kitchen");

-- CreateIndex
CREATE INDEX "Order_guestSessionId_idx" ON "Order"("guestSessionId");

-- CreateIndex
CREATE INDEX "Order_kitchen_status_createdAt_idx" ON "Order"("kitchen", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_collectionAt_idx" ON "Order"("collectionAt");

