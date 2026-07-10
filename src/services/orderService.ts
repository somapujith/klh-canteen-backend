import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { signOrderToken, verifyOrderToken } from "../lib/orderToken.js";
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

  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: items.map((i) => i.menuItemId) } },
  });
  if (menuItems.length !== items.length) {
    throw new ApiError(400, "INVALID_ITEM", "One or more menu items not found");
  }

  let totalAmount = 0;
  const orderItemsData = items.map((i) => {
    const menuItem = menuItems.find((m) => m.id === i.menuItemId)!;
    const lineTotal = Number(menuItem.price) * i.qty;
    totalAmount += lineTotal;
    return { menuItemId: i.menuItemId, quantity: i.qty, priceAtOrder: menuItem.price };
  });

  const weekId = getWeekId();
  const sequence = await prisma.orderSequence.upsert({
    where: { weekId },
    update: { lastNumber: { increment: 1 } },
    create: { weekId, lastNumber: 1000 },
  });

  const order = await prisma.order.create({
    data: {
      studentId,
      status: "PENDING",
      token: "placeholder",
      orderNumber: sequence.lastNumber,
      totalAmount: totalAmount.toFixed(2),
      items: { create: orderItemsData },
    },
    include: { items: { include: { menuItem: true } } },
  });

  const token = signOrderToken(order.id);
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { token },
    include: { items: { include: { menuItem: true } } },
  });

  const qrDataUrl = await QRCode.toDataURL(token);

  return { ...updated, qrDataUrl };
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

export async function getOrderByToken(token: string) {
  const orderId = verifyOrderToken(token);
  if (!orderId) throw new ApiError(400, "INVALID_TOKEN", "Invalid or tampered QR token");
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { menuItem: true } }, student: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  return order;
}

export async function getAllOrders() {
  return prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } }, student: true },
  });
}

export async function getAdminStats() {
  const now = new Date();
  // Using local timezone roughly by taking midnight of current UTC day
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const todaysOrders = await prisma.order.findMany({
    where: {
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

export async function deliverOrder(orderId: string) {
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Order not found");

  return prisma.$transaction(
    async (tx) => {
      // Re-check status and stock INSIDE the transaction using row locks
      // (SELECT ... FOR UPDATE), not the pre-transaction read above. Under
      // Postgres's default READ COMMITTED isolation, a plain SELECT is an
      // MVCC snapshot read and takes no lock, so two concurrent deliver
      // requests for the same order (or for different orders competing for
      // the same menu item's stock) could both pass a check based on stale
      // data before either commits. FOR UPDATE forces the second transaction
      // to block on the first transaction's row lock and then re-read the
      // post-commit state, which is what actually prevents double-delivery
      // and overselling under concurrency.
      const lockedOrderRows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      const lockedOrder = lockedOrderRows[0];
      if (!lockedOrder) throw new ApiError(404, "NOT_FOUND", "Order not found");
      if (lockedOrder.status === "DELIVERED") {
        throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
      }

      // Lock menu item rows in a deterministic order (sorted by id) to avoid
      // deadlocks between concurrent transactions that touch overlapping sets
      // of items in different orders.
      const menuItemIds = [...new Set(existing.items.map((line) => line.menuItemId))].sort();
      const lockedItems = await tx.$queryRaw<{ id: string; name: string; stockQty: number }[]>`
        SELECT id, name, "stockQty" FROM "MenuItem" WHERE id = ANY(${menuItemIds}) FOR UPDATE
      `;
      const lockedById = new Map(lockedItems.map((item) => [item.id, item]));

      for (const line of existing.items) {
        const menuItem = lockedById.get(line.menuItemId);
        if (!menuItem || menuItem.stockQty < line.quantity) {
          throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${menuItem?.name ?? line.menuItemId}`);
        }
      }
      for (const line of existing.items) {
        await tx.menuItem.update({
          where: { id: line.menuItemId },
          data: { stockQty: { decrement: line.quantity } },
        });
      }
      return tx.order.update({
        where: { id: orderId },
        data: { status: "DELIVERED", deliveredAt: new Date() },
        include: { items: { include: { menuItem: true } } },
      });
    },
    // Bursts of concurrent scans against the same order/menu item serialize
    // on the FOR UPDATE row locks above (by design — this is what prevents
    // overselling). Under real traffic (200+ concurrent requests, per the
    // system's concurrency target) that queue can exceed Prisma's default
    // 5s transaction timeout / 2s connection-acquire wait, which would
    // otherwise surface as an opaque 500 instead of a clean, retryable
    // response. Widen both so waiting for a lock is treated as normal
    // backpressure, not a failure.
    { maxWait: 10_000, timeout: 15_000 }
  );
}
