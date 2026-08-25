import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";

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
 */
export async function getCategorizedMenu(prisma: PrismaClient, kitchen?: string, isAdmin?: boolean) {
  const where = kitchen ? { kitchen: kitchen as any } : {};
  const categories = await prisma.category.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        // An admin must see the items they have switched off — hiding one is
        // reversible only if it is still on the page that hid it.
        where: isAdmin ? undefined : { isAvailable: true },
      },
    },
  });

  if (isAdmin) return { categories };

  return {
    categories: categories.map((category) => ({
      ...category,
      items: category.items.map((item) => {
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

export async function createCategory(prisma: PrismaClient, name: string, sortOrder: number, kitchen: string = "SNACKS") {
  return prisma.category.create({ data: { name, sortOrder, kitchen: kitchen as any } });
}

export async function updateCategory(
  prisma: PrismaClient,
  id: string,
  data: { name?: string; sortOrder?: number },
  adminKitchen?: string | null
) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && existing.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this category.");
  }
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(prisma: PrismaClient, id: string, adminKitchen?: string | null) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && existing.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to delete this category.");
  }
  return prisma.category.delete({ where: { id } });
}

export async function createMenuItem(
  prisma: PrismaClient,
  data: {
    name: string;
    imageUrl: string;
    price: string;
    stockQty: number;
    categoryId: string;
  }
) {
  return prisma.menuItem.create({ data });
}

export async function updateMenuItem(
  prisma: PrismaClient,
  id: string,
  data: Partial<{ name: string; imageUrl: string; price: string; stockQty: number; isAvailable: boolean; categoryId: string }>,
  adminKitchen?: string | null
) {
  const existing = await prisma.menuItem.findUnique({ where: { id }, include: { category: true } });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && existing.category.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this menu item.");
  }
  return prisma.menuItem.update({ where: { id }, data });
}

export async function deleteMenuItem(prisma: PrismaClient, id: string, adminKitchen?: string | null) {
  const existing = await prisma.menuItem.findUnique({ where: { id }, include: { category: true } });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && existing.category.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to delete this menu item.");
  }
  return prisma.menuItem.delete({ where: { id } });
}

export async function bulkUpdateCategoryItems(
  prisma: PrismaClient,
  categoryId: string,
  data: Partial<{ isAvailable: boolean; stockQty: number }>,
  adminKitchen?: string | null
) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found");
  if (adminKitchen && category.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this category's items.");
  }
  return prisma.menuItem.updateMany({
    where: { categoryId },
    data,
  });
}
