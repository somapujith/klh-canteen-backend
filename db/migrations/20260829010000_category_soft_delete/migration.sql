-- Same problem as 20260829000000_menu_item_soft_delete, one level up: deleting
-- a category returned a 500 because MenuItem's FK to Category is ON DELETE
-- RESTRICT (see 20260710205909_init), so any category still holding items —
-- including items archived by the previous migration, which the admin UI no
-- longer shows — refused to delete with a 23503.
--
-- Deleting a category now archives it together with its live items, in one
-- transaction. The rows survive so order history keeps resolving what was
-- sold; the category and its contents leave the menu and the admin list.
ALTER TABLE "Category" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT FALSE;

-- Category lists are always ordered by sortOrder and always filtered to the
-- live rows, so the index carries both.
CREATE INDEX "Category_isArchived_sortOrder_idx"
  ON "Category" ("sortOrder") WHERE "isArchived" = FALSE;
