-- Menus were entirely shared between KLH and DRK: Category and MenuItem had
-- no school column at all, only "kitchen" (SNACKS/MEALS), which is a
-- food-station dimension orthogonal to school. A KLH admin editing stock or
-- deleting an item affected DRK's customer-facing menu too. This adds the
-- missing dimension so each school's inventory is fully independent.
--
-- "school" NOT NULL DEFAULT 'KLH' on both tables mirrors Order."school"
-- (20260910160000_order_school_column) and gives every existing row — today
-- a single shared menu — to KLH. DRK admins start with an empty menu and
-- build their own from here; nothing is duplicated across schools.
ALTER TABLE "Category" ADD COLUMN "school" "School" NOT NULL DEFAULT 'KLH';
ALTER TABLE "MenuItem" ADD COLUMN "school" "School" NOT NULL DEFAULT 'KLH';

-- MenuItem.school is denormalized from its Category rather than joined for
-- every read — every existing kitchen-scoped query in menuItemRepo.ts reads
-- MenuItem directly with no JOIN to Category, and adding one to every such
-- query is a much larger, riskier change than keeping two columns in sync at
-- write time (the same tradeoff Order."kitchen" already makes against
-- OrderItem). createMenuItem/updateMenuItem in menuService.ts are
-- responsible for keeping this equal to the owning category's school.
CREATE INDEX "Category_school_kitchen_idx" ON "Category" ("school", "kitchen");
CREATE INDEX "MenuItem_school_categoryId_idx" ON "MenuItem" ("school", "categoryId");
