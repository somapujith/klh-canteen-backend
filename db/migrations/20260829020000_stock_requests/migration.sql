-- "Tell me when this is back" — a student's request for an item that has run
-- out, and the demand signal the admin restocks against.
--
-- UNIQUE (menuItemId, studentId) is the whole design in one constraint: the
-- count is meant to answer "how many students want this", so a student
-- tapping the button five times must not read as five students. The insert
-- is ON CONFLICT DO NOTHING against this, making the request idempotent in
-- the database rather than in a check-then-insert the next concurrent tap
-- would race through.
--
-- Both FKs CASCADE, unlike OrderItem's deliberate RESTRICT (see
-- 20260829000000_menu_item_soft_delete): a pending request is a live signal,
-- not history. Once the item is archived or the student's account is gone,
-- the request means nothing and should leave with it.
CREATE TABLE "StockRequest" (
  "id" TEXT PRIMARY KEY,
  "menuItemId" TEXT NOT NULL REFERENCES "MenuItem"("id") ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "StockRequest_menuItemId_studentId_key" UNIQUE ("menuItemId", "studentId")
);

-- The admin view aggregates by item; the notify blast reads one item's
-- requesters. Both are covered by the unique constraint's implicit index on
-- (menuItemId, studentId), so only the student-side lookup needs its own.
CREATE INDEX "StockRequest_studentId_idx" ON "StockRequest" ("studentId");
