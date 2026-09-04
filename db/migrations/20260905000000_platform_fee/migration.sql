-- Per-school platform fee %, set independently by the superadmin for KLH and
-- DRK and applied on top of the order subtotal at checkout.
--
-- "school" is the natural-key primary key here (one row per School value, no
-- separate UUID) — mirrors CollectionWindow's composite-unique-index idiom,
-- simpler since there's only one key column. No row for a school means 0%,
-- read via COALESCE rather than guessed in application code.
CREATE TABLE "SchoolSettings" (
  "school" "School" PRIMARY KEY,
  "platformFeePercent" NUMERIC(5,2) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NOTE ON Order."school": this migration originally also added
-- Order."school" (`ALTER TABLE "Order" ADD COLUMN "school" "School" NOT NULL
-- DEFAULT 'KLH'`) plus an `Order_school_idx` index, per the approved plan's
-- Context section, which stated no such column existed yet. Exploration of
-- the actual shared test database (a real Neon branch, not a local/ephemeral
-- one) found the column already present — added by a migration named
-- `20260829050000_order_category_school`, applied 2026-08-29, whose .sql file
-- does not exist anywhere in this repo or its git history (pre-existing
-- drift between the tracked migration set and the shared branch, not
-- something introduced by this change). The column's actual definition
-- (`"School" NOT NULL DEFAULT 'KLH'`) matches exactly what this migration
-- would have created, and a covering index
-- (`Order_school_kitchen_status_createdAt_idx`) already exists, so nothing
-- here re-adds either. Only what was actually missing — SchoolSettings and
-- platformFeeAmount — is added below.

-- Snapshotted fee amount, not a live-computed percentage — same reasoning as
-- OrderItem.priceAtOrder: if the superadmin changes the fee % next week, last
-- week's orders must keep showing what was actually charged.
ALTER TABLE "Order" ADD COLUMN "platformFeeAmount" NUMERIC(10,2) NOT NULL DEFAULT 0;
