import type { Pool, PoolClient } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import * as categoryRepo from "../db/categoryRepo.js";
import * as menuItemRepo from "../db/menuItemRepo.js";
import type { Category, Kitchen, MenuItem } from "../db/schema.js";
import type { QueryRunner } from "../db/sql.js";

// Widened to accept lib/db.ts's HTTP getHttpSql() client alongside Pool/
// PoolClient. Every function in this file issues exactly one query() call
// per invocation (no interactive transaction), so this is safe for the
// write paths too — only the route layer decides which runner to pass, and
// only routes/menu.ts's read (getCategorizedMenu) actually uses the HTTP one.
//
// deleteCategory is the one exception: its archive cascade spans two
// statements that must commit together, so it demands a real Pool.
type Runner = Pool | PoolClient | QueryRunner;

/**
 * The menu, from two different points of view.
 *
 * STOCK MEANS DIFFERENT THINGS TO THE TWO CALLERS, and conflating them was a
 * bug in both directions:
 *
 *   A CUSTOMER cares what they can still buy, which is `stockQty` minus the
 *   portions already claimed by orders that have not been collected yet. This
 *   used to return the raw `stockQty`, so the menu advertised portions other
 *   people had already reserved. The realtime path never had that fault — see
 *   emitStockForOrders() in routes/orders.ts, which has always broadcast
 *   `stockQty - reservedQty` — so the first SSE delta after page load visibly
 *   corrected the number downwards. Worse, an item whose whole stock was
 *   reserved still advertised portions, and the order only failed at the
 *   claim, after the student had committed to it.
 *
 *   AN ADMIN cares what is physically on the counter, because that is the
 *   number they restock against. They get the raw `stockQty` plus
 *   `reservedQty` alongside it, so the customer-facing figure is derivable
 *   rather than guessed at.
 *
 * The customer projection is deliberately identical to the one emitStockForOrders
 * broadcasts, including the `isAvailable` rule: a fully reserved item reads as
 * sold out rather than disappearing, which is what the menu already renders for
 * a zero-stock item.
 *
 * Implemented as two queries (categories, then their items) joined in
 * memory rather than one JOIN — this codebase's own idiom for anything past
 * a trivial join (see auditLogRepo's doc comment for the one place a single
 * JOIN was chosen instead, and why).
 */
export async function getCategorizedMenu(runner: Runner, kitchen?: string, isAdmin?: boolean) {
  const categories = await categoryRepo.findCategories(runner, kitchen as Kitchen | undefined);
  const categoryIds = categories.map((c) => c.id);
  // An admin must see the items they have switched off — hiding one is
  // reversible only if it is still on the page that hid it.
  const items = await menuItemRepo.findMenuItemsByCategoryIds(runner, categoryIds, {
    availableOnly: !isAdmin,
  });

  const itemsByCategory = new Map<string, MenuItem[]>();
  for (const item of items) {
    const bucket = itemsByCategory.get(item.categoryId) ?? [];
    bucket.push(item);
    itemsByCategory.set(item.categoryId, bucket);
  }

  if (isAdmin) {
    return {
      categories: categories.map((category) => ({
        ...category,
        items: itemsByCategory.get(category.id) ?? [],
      })),
    };
  }

  return {
    categories: categories.map((category) => ({
      ...category,
      items: (itemsByCategory.get(category.id) ?? []).map((item) => {
        const available = Math.max(0, item.stockQty - item.reservedQty);
        return {
          ...item,
          stockQty: available,
          isAvailable: item.isAvailable && available > 0,
        };
      }),
    })),
  };
}

export async function createCategory(
  runner: Runner,
  name: string,
  sortOrder: number,
  kitchen: Kitchen | string = "SNACKS"
): Promise<Category> {
  return categoryRepo.insertCategory(runner, { name, sortOrder, kitchen: kitchen as Kitchen });
}

export async function updateCategory(
  runner: Runner,
  id: string,
  data: { name?: string; sortOrder?: number },
  adminKitchen?: string | null
): Promise<Category> {
  const existing = await categoryRepo.findCategoryById(runner, id);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && existing.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this category.");
  }
  return categoryRepo.updateCategory(runner, id, data);
}

/**
 * Archives the category and everything in it — see Category.isArchived. Takes
 * a Pool rather than a Runner because the cascade is transactional.
 *
 * Returns the number of items archived alongside it; the route reports that
 * in the audit log, since "deleted a category" understates removing a dozen
 * items with it.
 */
export async function deleteCategory(
  pool: Pool,
  id: string,
  adminKitchen?: string | null
): Promise<{ archivedItems: number }> {
  const existing = await categoryRepo.findCategoryById(pool, id);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && existing.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to delete this category.");
  }
  return categoryRepo.archiveCategoryWithItems(pool, id);
}

export async function createMenuItem(
  runner: Runner,
  data: {
    name: string;
    imageUrl?: string | null;
    price: string;
    stockQty: number;
    categoryId: string;
  }
): Promise<MenuItem> {
  return menuItemRepo.insertMenuItem(runner, data);
}

export async function updateMenuItem(
  runner: Runner,
  id: string,
  data: Partial<{ name: string; imageUrl: string | null; price: string; stockQty: number; isAvailable: boolean; categoryId: string }>,
  adminKitchen?: string | null
): Promise<MenuItem> {
  const existing = await menuItemRepo.findMenuItemWithCategoryKitchen(runner, id);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && existing.categoryKitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this menu item.");
  }
  return menuItemRepo.updateMenuItem(runner, id, data);
}

/**
 * Archives rather than hard-deletes — OrderItem's ON DELETE RESTRICT FK makes
 * a real DELETE impossible for any item that has ever been ordered, and order
 * history has to keep resolving the item it names. See MenuItem.isArchived.
 */
export async function deleteMenuItem(runner: Runner, id: string, adminKitchen?: string | null): Promise<void> {
  const existing = await menuItemRepo.findMenuItemWithCategoryKitchen(runner, id);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && existing.categoryKitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to delete this menu item.");
  }
  await menuItemRepo.archiveMenuItem(runner, id);
}

export async function bulkUpdateCategoryItems(
  runner: Runner,
  categoryId: string,
  data: Partial<{ isAvailable: boolean; stockQty: number }>,
  adminKitchen?: string | null
): Promise<{ count: number }> {
  const category = await categoryRepo.findCategoryById(runner, categoryId);
  if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && category.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this category's items.");
  }
  const count = await menuItemRepo.updateMenuItemsByCategory(runner, categoryId, data);
  return { count };
}
