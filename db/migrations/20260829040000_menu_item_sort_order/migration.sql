-- Items within a category had no explicit order — whatever the DB happened
-- to return. Mirrors Category.sortOrder (20260710205909_init) so the admin
-- inventory page can drag-reorder items the same way it already reorders
-- categories.
ALTER TABLE "MenuItem" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
