-- Reconciles migration history with the schema.
--
-- PREPARING/COOKED and Order.seenByAdmin/seenAt reached the live database via
-- `prisma db push` and were never recorded as a migration. A fresh environment
-- built from migrations alone therefore could not represent the kitchen
-- workflow at all. Every statement is idempotent so this applies cleanly to a
-- database that already has them and to one that does not.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PREPARING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'COOKED';

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "seenByAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "seenAt" TIMESTAMP(3);
