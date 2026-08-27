-- Stock reservation + lock-free order numbering.
--
-- PURELY ADDITIVE. No column is dropped, no row is touched, no data is
-- rewritten. Existing orders keep `reservedAt` NULL, which the service reads
-- as "this order holds no reservation" and therefore keeps decrementing its
-- stock at DELIVERED exactly as it always did.

-- AlterEnum
-- CANCELLED is the release trigger for a reservation. Added here and used by
-- no statement in this migration, which is what makes ADD VALUE safe inside
-- the migration's transaction.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "reservedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "reservationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "reservedAt" TIMESTAMP(3),
ADD COLUMN     "stockSettledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_stockSettledAt_reservationExpiresAt_idx" ON "Order"("stockSettledAt", "reservationExpiresAt");

-- Order numbering, moved off the single-row global sequence.
--
-- The old scheme upserted ONE OrderSequence row per week inside the order
-- transaction, so every order placed on campus queued behind one row lock
-- held across the whole round trip to this region. A Postgres sequence is
-- the opposite: nextval() is non-transactional and takes no row lock, so it
-- never makes one order wait for another.
--
-- One sequence per kitchen, because each kitchen calls its own numbers out.
-- CYCLE between 1000 and 9999 keeps them four digits and shoutable; the
-- wrap only has to outlast the lifetime of a live order, and at canteen
-- volume a full lap takes weeks. START is set above the highest number in
-- use today so no number is reissued while its order is still on the board.
CREATE SEQUENCE IF NOT EXISTS "order_number_snacks"
  AS integer INCREMENT BY 1 MINVALUE 1000 MAXVALUE 9999 START WITH 1500 CYCLE;
CREATE SEQUENCE IF NOT EXISTS "order_number_meals"
  AS integer INCREMENT BY 1 MINVALUE 1000 MAXVALUE 9999 START WITH 1500 CYCLE;
