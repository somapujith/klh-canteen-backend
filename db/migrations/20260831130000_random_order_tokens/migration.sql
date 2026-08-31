-- Order numbers move from a sequential per-kitchen counter to a random
-- 4-digit token, unique only among that kitchen's still-open orders. A
-- DELIVERED or CANCELLED order frees its number for reuse immediately —
-- there's no reason to wait out a "full lap" once an order is off the board.
--
-- The two CYCLE sequences from 20260824120000 are no longer called; nothing
-- else reads them, so they're dropped rather than left as dead objects.
DROP SEQUENCE IF EXISTS "order_number_snacks";
DROP SEQUENCE IF EXISTS "order_number_meals";

-- Enforced by Postgres at insert time, not chosen by the app: the app picks
-- a random number and this index is what makes a collision fail loudly
-- (23505) instead of silently handing two open orders the same number. The
-- app catches that and retries with a fresh number — see insertOrders() in
-- orderService.ts. Partial so a DELIVERED/CANCELLED order's old number
-- doesn't block reissuing it to a new order.
CREATE UNIQUE INDEX "Order_kitchen_orderNumber_open_key"
  ON "Order" ("kitchen", "orderNumber")
  WHERE "status" NOT IN ('DELIVERED', 'CANCELLED');
