-- Deleting a menu item that has ever been ordered was impossible: OrderItem's
-- FK to MenuItem is ON DELETE RESTRICT (see 20260710205909_init), so Postgres
-- refused the DELETE with a 23503 foreign_key_violation, which surfaced in the
-- admin UI as an opaque 500.
--
-- That RESTRICT is correct and stays: an OrderItem row pointing at a deleted
-- MenuItem would corrupt order history, and every reporting/export path
-- (orderExportService.ts, getOrderDetail) joins MenuItem to name what was
-- actually sold. Cascading the delete would silently rewrite past sales.
--
-- So "delete" becomes archival. The row survives for history; the item leaves
-- the menu and the admin inventory list for good. Unlike isAvailable — a
-- reversible day-to-day "we're out of samosas" toggle the admin flips from the
-- item row — isArchived is the terminal state the delete button now produces.
ALTER TABLE "MenuItem" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT FALSE;

-- Every menu-browsing read filters on this alongside categoryId/isAvailable;
-- partial index because archived rows are the rare case and only the live ones
-- are ever scanned by those paths.
CREATE INDEX "MenuItem_categoryId_isArchived_idx"
  ON "MenuItem" ("categoryId") WHERE "isArchived" = FALSE;
