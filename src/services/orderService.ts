import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { signOrderToken, verifyOrderToken } from "../lib/orderToken.js";
import { ApiError } from "../middleware/errorHandler.js";

interface CreateOrderInput {
  studentId: string;
  items: { menuItemId: string; qty: number }[];
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

  const order = await prisma.order.create({
    data: {
      studentId,
      status: "PENDING",
      token: "placeholder",
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
  return prisma.order.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } } },
  });
}

export async function getOrderForStudent(orderId: string, studentId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, studentId },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  return order;
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
