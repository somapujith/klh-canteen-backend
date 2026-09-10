-- Adds Order."school", which 20260905000000_platform_fee assumed already
-- existed on production.
--
-- That migration's own comment explains why it skipped adding this column:
-- exploring a shared Neon branch found "school" already present, credited to
-- an untracked migration (`20260829050000_order_category_school`) whose .sql
-- file exists nowhere in this repo. That premise turned out to be wrong for
-- THIS deployment's database — the column and its covering index were never
-- actually added here, which the 500 on POST /orders
-- (`column "school" of relation "Order" does not exist`) surfaced directly.
-- Rather than repeat the earlier investigation's mistake of trusting a
-- comment over the live schema, this migration re-checks with
-- information_schema and only adds what is genuinely still missing, so it is
-- safe to run again on a database where the phantom migration DID apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'Order' AND column_name = 'school'
  ) THEN
    ALTER TABLE "Order" ADD COLUMN "school" "School" NOT NULL DEFAULT 'KLH';
  END IF;
END $$;

-- Additive only — the existing Order_kitchen_status_createdAt_idx is left in
-- place rather than dropped, since a hotfix migration is the wrong place to
-- also change what every board query's plan relies on.
CREATE INDEX IF NOT EXISTS "Order_school_kitchen_status_createdAt_idx"
  ON "Order" ("school", "kitchen", "status", "createdAt");
