import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { openOrderForAdmin, updateOrderStatus, getAllOrders, getAdminStats } from "../services/orderService.js";
import { sseService } from "../services/sseService.js";
import { logAction } from "../services/auditService.js";
import { getBindings, getRequestPrisma } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminOrdersRouter = new Hono<AppEnv>();

const idParamSchema = z.string().uuid();
const statusBodySchema = z.object({ status: z.enum(["PREPARING", "COOKED", "DELIVERED"]) });
const ACTIVE_STATUSES = ["PENDING", "PREPARING", "COOKED"];

adminOrdersRouter.get("/", requireAuth("ADMIN"), async (c) => {
  const activeOnly = c.req.query("active") === "true";
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const orders = await getAllOrders(prisma, user.kitchen || undefined, activeOnly ? ACTIVE_STATUSES : undefined);
  const serialized = orders.map((order) => ({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) }));
  return c.json(serialized);
});

adminOrdersRouter.get("/stats", requireAuth("ADMIN"), async (c) => {
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const stats = await getAdminStats(prisma, user.kitchen || undefined);
  return c.json(stats);
});

adminOrdersRouter.get("/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const order = await openOrderForAdmin(prisma, id, user.id, user.kitchen || undefined);
  await sseService.broadcastOrderBoardUpdate(getBindings(c));
  return c.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
});

adminOrdersRouter.patch("/:id/status", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const { status } = statusBodySchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const order = await updateOrderStatus(prisma, id, status, user.kitchen || undefined);
  if (!user.kitchen || user.kitchen !== order.kitchen) {
    await logAction(prisma, user.id, "ORDER_STATUS_OVERRIDE", "Order", order.id, { kitchen: order.kitchen, status });
  }
  const bindings = getBindings(c);
  if (status === "DELIVERED") {
    await sseService.notifyOrderUpdate(bindings, order.studentId, order.id, order.status);
    await sseService.broadcastMenuUpdate(bindings);
  }
  await sseService.broadcastOrderBoardUpdate(bindings);
  return c.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
});
