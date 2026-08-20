import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { createOrder, getStudentOrders, getOrderForStudent } from "../services/orderService.js";
import { sseService } from "../services/sseService.js";

export const ordersRouter = Router();

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
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // The integration test suite legitimately creates more than 5 orders per
  // minute against a single shared app instance (many test cases, one IP).
  // Skip only under NODE_ENV=test (set automatically by vitest); production
  // and dev behavior is unchanged.
  skip: () => process.env.NODE_ENV === "test",
  message: { error: { message: "Too many orders placed, please wait a minute.", code: "TOO_MANY_ORDERS" } }
});

ordersRouter.post("/", requireAuth("STUDENT"), orderLimiter, async (req, res, next) => {
  try {
    const { items } = createOrderSchema.parse(req.body);
    const orders = await createOrder({ studentId: req.user!.id, items });
    sseService.broadcastMenuUpdate();
    sseService.broadcastOrderBoardUpdate();
    res.status(201).json(orders.map(serializeOrder));
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/my", requireAuth("STUDENT"), async (req, res, next) => {
  try {
    const orders = await getStudentOrders(req.user!.id);
    res.json(orders.map(serializeOrder));
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/:id", requireAuth("STUDENT"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const order = await getOrderForStudent(id, req.user!.id);
    res.json(serializeOrder(order));
  } catch (err) {
    next(err);
  }
});
