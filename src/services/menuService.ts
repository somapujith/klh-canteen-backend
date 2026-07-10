import { prisma } from "../lib/prisma.js";

export async function getCategorizedMenu(kitchen?: string, isAdmin?: boolean) {
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

export async function createCategory(name: string, sortOrder: number, kitchen: string = "SNACKS") {
  return prisma.category.create({ data: { name, sortOrder, kitchen: kitchen as any } });
}

export async function updateCategory(id: string, data: { name?: string; sortOrder?: number }) {
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(id: string) {
  return prisma.category.delete({ where: { id } });
}

export async function createMenuItem(data: {
  name: string;
  imageUrl: string;
  price: string;
  stockQty: number;
  categoryId: string;
}) {
  return prisma.menuItem.create({ data });
}

export async function updateMenuItem(
  id: string,
  data: Partial<{ name: string; imageUrl: string; price: string; stockQty: number; isAvailable: boolean; categoryId: string }>
) {
  return prisma.menuItem.update({ where: { id }, data });
}

export async function deleteMenuItem(id: string) {
  return prisma.menuItem.delete({ where: { id } });
}
