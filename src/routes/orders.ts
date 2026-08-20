import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createOrder, getStudentOrders, getOrderForStudent } from "../services/orderService.js";
import { sseService } from "../services/sseService.js";
import { getBindings, getRequestPrisma } from "../lib/context.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { AppEnv } from "../types.js";

export const ordersRouter = new Hono<AppEnv>();

const createOrderSchema = z.object({
  items: z.array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1) })).min(1),
});
const idParamSchema = z.string().uuid();

// Prisma's Decimal.toJSON() uses decimal.js toString(), which drops trailing
// zeros (e.g. "20.00" -> "20"). Re-format money fields to a fixed 2-decimal
// string at the API boundary so clients always get a consistent shape.
function serializeOrder<T extends { totalAmount: unknown; items: { priceAtOrder: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: Number(order.totalAmount).toFixed(2),
    qrDataUrl: (order as any).qrDataUrl,
    orderNumber: (order as any).orderNumber,
    items: order.items.map((item) => ({
      ...item,
      priceAtOrder: Number(item.priceAtOrder).toFixed(2),
    })),
  };
}

const orderLimiter = rateLimit({
  prefix: "orders",
  windowSeconds: 60,
  max: 5,
  code: "TOO_MANY_ORDERS",
  message: "Too many orders placed, please wait a minute.",
});

ordersRouter.post("/", requireAuth("STUDENT"), orderLimiter, async (c) => {
  const { items } = createOrderSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const { QR_TOKEN_SECRET } = getBindings(c);
  const user = c.get("user")!;
  const orders = await createOrder(prisma, QR_TOKEN_SECRET, { studentId: user.id, items });
  await sseService.broadcastMenuUpdate(getBindings(c));
  await sseService.broadcastOrderBoardUpdate(getBindings(c));
  return c.json(orders.map(serializeOrder), 201);
});

ordersRouter.get("/my", requireAuth("STUDENT"), async (c) => {
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const orders = await getStudentOrders(prisma, user.id);
  return c.json(orders.map(serializeOrder));
});

ordersRouter.get("/:id", requireAuth("STUDENT"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const order = await getOrderForStudent(prisma, id, user.id);
  return c.json(serializeOrder(order));
});
