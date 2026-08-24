import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";

export async function getCategorizedMenu(prisma: PrismaClient, kitchen?: string, isAdmin?: boolean) {
  const where = kitchen ? { kitchen: kitchen as any } : {};
  const categories = await prisma.category.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: isAdmin ? undefined : { isAvailable: true },
      },
    },
  });
  return { categories };
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
