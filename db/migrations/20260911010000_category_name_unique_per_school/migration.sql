-- Category_name_key was a global UNIQUE index on "name" alone, predating the
-- "school" column added in 20260911000000_menu_school_scoping. With menus now
-- fully independent per school, two schools legitimately both wanting a
-- category named "Beverages" is normal, not a collision — discovered when
-- duplicating KLH's menu into DRK failed outright on the first category.
--
-- Scoping the uniqueness to (school, name) keeps the original intent (no two
-- categories with the same name inside one school's menu) while dropping the
-- now-wrong cross-school restriction.
DROP INDEX IF EXISTS "Category_name_key";
CREATE UNIQUE INDEX "Category_school_name_key" ON "Category" ("school", "name");
