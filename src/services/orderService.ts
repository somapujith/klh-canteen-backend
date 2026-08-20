import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { signOrderToken } from "../lib/orderToken.js";
import { ApiError } from "../middleware/errorHandler.js";

interface CreateOrderInput {
  studentId: string;
  items: { menuItemId: string; qty: number }[];
}

function getWeekId(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

export async function createOrder({ studentId, items }: CreateOrderInput) {
  if (items.length === 0) throw new ApiError(400, "EMPTY_ORDER", "Order must have at least one item");

  return prisma.$transaction(async (tx) => {
    // 1. Lock items and check stock to prevent overselling
    const menuItemIds = [...new Set(items.map((i) => i.menuItemId))].sort();
    const lockedItems = await tx.$queryRaw<{ id: string; name: string; stockQty: number }[]>`
      SELECT id, name, "stockQty" FROM "MenuItem" WHERE id = ANY(${menuItemIds}) FOR UPDATE
    `;
    const lockedById = new Map(lockedItems.map((item) => [item.id, item]));

    for (const item of items) {
      const lockedItem = lockedById.get(item.menuItemId);
      if (!lockedItem || lockedItem.stockQty < item.qty) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${lockedItem?.name ?? item.menuItemId}`);
      }
    }

    // 2. Decrement stock
    for (const item of items) {
      await tx.menuItem.update({
        where: { id: item.menuItemId },
        data: { stockQty: { decrement: item.qty } },
      });
    }

    // 3. Re-fetch menu items to get their categories for kitchen splitting
    const menuItems = await tx.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      include: { category: true }
    });

    // 4. Split by kitchen and create orders
    const kitchenItems: Record<string, { menuItem: typeof menuItems[0], qty: number }[]> = {};
    items.forEach((i) => {
      const menuItem = menuItems.find((m) => m.id === i.menuItemId)!;
      const kitchen = menuItem.category.kitchen || "SNACKS";
      if (!kitchenItems[kitchen]) kitchenItems[kitchen] = [];
      kitchenItems[kitchen].push({ menuItem, qty: i.qty });
    });

    const createdOrders = [];
    const weekId = getWeekId();

    for (const [kitchen, kItems] of Object.entries(kitchenItems)) {
      let totalAmount = 0;
      const orderItemsData = kItems.map(({ menuItem, qty }) => {
        totalAmount += Number(menuItem.price) * qty;
        return { menuItemId: menuItem.id, quantity: qty, priceAtOrder: menuItem.price };
      });

      const sequence = await tx.orderSequence.upsert({
        where: { weekId },
        update: { lastNumber: { increment: 1 } },
        create: { weekId, lastNumber: 1000 },
      });

      const order = await tx.order.create({
        data: {
          studentId,
          kitchen: kitchen as any,
          status: "PENDING",
          token: "placeholder",
          orderNumber: sequence.lastNumber,
          totalAmount: totalAmount.toFixed(2),
          items: { create: orderItemsData },
        },
        include: { items: { include: { menuItem: true } } },
      });

      const token = signOrderToken(order.id);
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { token },
        include: { items: { include: { menuItem: true } } },
      });

      const qrDataUrl = await QRCode.toDataURL(token);
      createdOrders.push({ ...updated, qrDataUrl });
    }

    return createdOrders;
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function getStudentOrders(studentId: string) {
  const orders = await prisma.order.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } } },
  });
  
  // Attach qrDataUrl to each order so the history can display it if needed
  return Promise.all(
    orders.map(async (order) => {
      const qrDataUrl = await QRCode.toDataURL(order.token);
      return { ...order, qrDataUrl };
    })
  );
}

export async function getOrderForStudent(orderId: string, studentId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, studentId },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  
  const qrDataUrl = await QRCode.toDataURL(order.token);
  return { ...order, qrDataUrl };
}

export async function getAllOrders(kitchen?: string, statuses?: string[]) {
  const where: any = {};
  if (kitchen) where.kitchen = kitchen;
  if (statuses) where.status = { in: statuses };
  return prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } }, student: true },
  });
}

export async function getAdminStats(kitchen?: string) {
  const now = new Date();
  // Using local timezone roughly by taking midnight of current UTC day
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const todaysOrders = await prisma.order.findMany({
    where: {
      ...(kitchen ? { kitchen: kitchen as any } : {}),
      createdAt: {
        gte: startOfDay,
        lte: endOfDay,
      }
    }
  });

  const totalOrdersToday = todaysOrders.length;
  const totalRevenueToday = todaysOrders.reduce((sum, order) => sum + Number(order.totalAmount), 0);

  return {
    totalOrdersToday,
    totalRevenueToday: totalRevenueToday.toFixed(2),
  };
}

const NEXT_STATUS: Record<string, string> = {
  PENDING: "PREPARING",
  PREPARING: "COOKED",
  COOKED: "DELIVERED",
};

export async function openOrderForAdmin(orderId: string, adminId: string, adminKitchen?: string | null) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { menuItem: true } }, student: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (adminKitchen && order.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", `This order belongs to the ${order.kitchen} kitchen.`);
  }

  let isLockedByOther = false;
  const now = new Date();
  if (order.status !== "DELIVERED" && order.lockedByAdminId && order.lockedByAdminId !== adminId && order.lockedAt) {
    const lockTimeout = 5 * 60 * 1000;
    if (now.getTime() - order.lockedAt.getTime() < lockTimeout) {
      isLockedByOther = true;
    }
  }

  const data: Record<string, unknown> = {};
  if (!order.seenByAdmin) {
    data.seenByAdmin = true;
    data.seenAt = now;
  }
  if (!isLockedByOther && order.status !== "DELIVERED") {
    data.lockedByAdminId = adminId;
    data.lockedAt = now;
  }

  const updated = Object.keys(data).length > 0
    ? await prisma.order.update({
        where: { id: order.id },
        data,
        include: { items: { include: { menuItem: true } }, student: true },
      })
    : order;

  return { ...updated, isLockedByOther };
}

export async function updateOrderStatus(orderId: string, targetStatus: string, adminKitchen?: string | null) {
  return prisma.$transaction(async (tx) => {
    const orders = await tx.$queryRaw<any[]>`SELECT status, kitchen FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    if (orders.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const existing = orders[0];

    if (adminKitchen && existing.kitchen !== adminKitchen) {
      throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to update this kitchen's orders.");
    }
    if (existing.status === "DELIVERED") {
      throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
    }
    if (NEXT_STATUS[existing.status] !== targetStatus) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot move order from ${existing.status} to ${targetStatus}`);
    }

    const data: Record<string, unknown> = { status: targetStatus };

    if (targetStatus === "DELIVERED") {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      const menuItemIds = [...new Set(order!.items.map((i) => i.menuItemId))].sort();
      const lockedItems = await tx.$queryRaw<{ id: string; name: string; stockQty: number }[]>`
        SELECT id, name, "stockQty" FROM "MenuItem" WHERE id = ANY(${menuItemIds}) FOR UPDATE
      `;
      const lockedById = new Map(lockedItems.map((item) => [item.id, item]));
      for (const item of order!.items) {
        const lockedItem = lockedById.get(item.menuItemId);
        if (!lockedItem || lockedItem.stockQty < item.quantity) {
          throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${lockedItem?.name ?? item.menuItemId}`);
        }
      }
      for (const item of order!.items) {
        await tx.menuItem.update({ where: { id: item.menuItemId }, data: { stockQty: { decrement: item.quantity } } });
      }
      data.deliveredAt = new Date();
    }

    return tx.order.update({
      where: { id: orderId },
      data,
      include: { items: { include: { menuItem: true } } },
    });
  }, { maxWait: 10_000, timeout: 15_000 });
}
