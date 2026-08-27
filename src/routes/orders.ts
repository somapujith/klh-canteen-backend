import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  createOrder,
  getStudentOrders,
  getOrderForStudent,
  getCollectionWindows,
  MAX_PREBOOK_DAYS,
  cancelOrder,
} from "../services/orderService.js";
import { emitOrderCreated, emitOrderStatusChanged, emitStockChanged } from "../services/sseService.js";
import { notifyStudentOrderTelegram } from "../services/telegramService.js";
import { toOrderSummary } from "../lib/orderSummary.js";
import { getBindings, getRequestPool } from "../lib/context.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { sql, query } from "../db/sql.js";
import type { Kitchen } from "../db/schema.js";
import type { AppEnv } from "../types.js";

// notifyStudentOrderTelegram: student-only order logs after create/cancel.
// User: integrate telegram with students only; order logs after link.

export const ordersRouter = new Hono<AppEnv>();

const createOrderSchema = z.object({
  items: z.array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1) })).min(1),
  /**
   * Optional ISO-8601 collection time. Absent means "as soon as possible",
   * which is exactly what every existing client sends today — pre-booking is
   * strictly additive and no current caller changes behaviour.
   */
  collectionAt: z.string().datetime({ offset: true }).optional(),
});
const idParamSchema = z.string().uuid();

// Prisma's Decimal.toJSON() uses decimal.js toString(), which drops trailing
// zeros (e.g. "20.00" -> "20"). Re-format money fields to a fixed 2-decimal
// string at the API boundary so clients always get a consistent shape.
function serializeOrder<T extends { totalAmount: unknown; items: { priceAtOrder: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: Number(order.totalAmount).toFixed(2),
    orderNumber: (order as any).orderNumber,
    // Opaque row key. Nothing outside the database reads it — collection is by
    // order number — so it stays off the wire.
    token: undefined,
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
  const { items, collectionAt } = createOrderSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const orders = await createOrder(pool, {
    owner: { studentId: user.id },
    items,
    collectionAt: collectionAt ? new Date(collectionAt) : null,
  });
  // One coalesced, data-carrying frame per kitchen instead of two full-refresh
  // fan-outs that made every connected client refetch the whole menu and board.
  const bindings = getBindings(c);
  await emitOrderCreated(bindings, orders.map(toOrderSummary));
  // Stock is reserved at order time now, so sellable quantity really does drop
  // here — push the absolute level so every open menu patches itself instead of
  // showing portions that are already spoken for.
  await emitStockForOrders(pool, bindings, orders);
  // Student-only Telegram order logs (no-op for unlinked students / missing token).
  await Promise.all(
    orders.map((order) =>
      notifyStudentOrderTelegram(pool, bindings, {
        studentId: order.studentId,
        orderNumber: order.orderNumber,
        status: order.status,
        kitchen: order.kitchen,
        totalAmount: order.totalAmount,
        items: order.items.map((i) => ({
          name: i.menuItem.name,
          quantity: i.quantity,
        })),
        kind: "created",
      })
    )
  );
  return c.json(orders.map(serializeOrder), 201);
});

ordersRouter.get("/my", requireAuth("STUDENT"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const orders = await getStudentOrders(pool, user.id);
  return c.json(orders.map(serializeOrder));
});

const windowsQuerySchema = z.object({
  kitchen: z.enum(["SNACKS", "MEALS"]),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * Which collection windows still have room, so the client can grey out full
 * slots rather than letting a student pick one and fail at checkout.
 * Slots with no booking yet simply do not appear — they are empty.
 */
ordersRouter.get("/collection-windows", requireAuth("STUDENT"), async (c) => {
  const { kitchen, from, to } = windowsQuerySchema.parse({
    kitchen: c.req.query("kitchen"),
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  const pool = getRequestPool(c);
  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : new Date(Date.now() + MAX_PREBOOK_DAYS * 24 * 60 * 60 * 1000);
  const windows = await getCollectionWindows(pool, kitchen, fromDate, toDate);
  return c.json(windows);
});

ordersRouter.get("/:id", requireAuth("STUDENT"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const order = await getOrderForStudent(pool, id, user.id);
  return c.json(serializeOrder(order));
});

/**
 * Cancels a student's own order and hands its reserved stock back, so an
 * abandoned basket doesn't hold portions hostage until the expiry sweeper
 * runs. Scoped by studentId in the lookup — a student can only cancel theirs.
 */
ordersRouter.post("/:id/cancel", requireAuth("STUDENT"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const order = await cancelOrder(pool, id, { studentId: user.id });

  await emitOrderStatusChanged(getBindings(c), {
    orderId: order.id,
    status: order.status,
    kitchen: order.kitchen,
    orderNumber: order.orderNumber,
    subjectId: order.studentId,
  });
  await notifyStudentOrderTelegram(pool, getBindings(c), {
    studentId: order.studentId,
    orderNumber: order.orderNumber,
    status: order.status,
    kitchen: order.kitchen,
    totalAmount: order.totalAmount,
    items: order.items.map((i) => ({
      name: i.menuItem.name,
      quantity: i.quantity,
    })),
    kind: "status",
  });
  return c.json(serializeOrder(order));
});

/**
 * Emits the post-reservation sellable level for every item an order touched.
 * Absolute values, never diffs, so a duplicated delta cannot corrupt a client.
 */
export async function emitStockForOrders(
  pool: ReturnType<typeof getRequestPool>,
  bindings: ReturnType<typeof getBindings>,
  orders: { kitchen: string; items: { menuItemId: string }[] }[]
) {
  const ids = [...new Set(orders.flatMap((o) => o.items.map((i) => i.menuItemId)))];
  if (ids.length === 0) return;

  const { rows: items } = await query<{
    id: string;
    stockQty: number;
    reservedQty: number;
    isAvailable: boolean;
    kitchen: Kitchen;
  }>(
    pool,
    sql`
    SELECT mi."id" AS "id", mi."stockQty" AS "stockQty", mi."reservedQty" AS "reservedQty",
           mi."isAvailable" AS "isAvailable", c."kitchen" AS "kitchen"
      FROM "MenuItem" mi
      JOIN "Category" c ON c."id" = mi."categoryId"
     WHERE mi."id" = ANY(${ids}::text[])
  `,
  );

  await emitStockChanged(
    bindings,
    items.map((i: { id: string; stockQty: number; reservedQty: number; isAvailable: boolean; kitchen: Kitchen }) => ({
      menuItemId: i.id,
      stockQty: Math.max(0, i.stockQty - i.reservedQty),
      isAvailable: i.isAvailable && i.stockQty - i.reservedQty > 0,
      kitchen: i.kitchen,
    }))
  );
}
