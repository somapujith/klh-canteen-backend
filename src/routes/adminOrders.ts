import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  openOrderForAdmin,
  updateOrderStatus,
  getAllOrders,
  getAdminStats,
  DEFAULT_ORDER_PAGE_SIZE,
  MAX_ORDER_PAGE_SIZE,
} from "../services/orderService.js";
import { emitOrderSeen, emitOrderStatusChanged, emitStockChanged } from "../services/sseService.js";
import { notifyStudentOrderTelegram } from "../services/telegramService.js";
import { guestSubjectIdOrNull } from "../services/guestSessionService.js";
import { logAction } from "../services/auditService.js";
import { getBindings, getRequestPool } from "../lib/context.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { AppEnv } from "../types.js";

// notifyStudentOrderTelegram on status patch — students only. User: order logs after telegram link.

export const adminOrdersRouter = new Hono<AppEnv>();

const idParamSchema = z.string().uuid();
const statusBodySchema = z.object({ status: z.enum(["PREPARING", "COOKED", "DELIVERED"]) });

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ORDER_PAGE_SIZE).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: z.string().min(1).optional(),
});

const ORDER_STATUSES = ["PENDING", "PREPARING", "COOKED", "DELIVERED"] as const;

/**
 * The kitchen board feed — now cursor-paginated.
 *
 * RESPONSE SHAPE, and why there are two of them:
 * The existing frontend does `orders.map(...)` straight on the response body,
 * so wrapping the array in an envelope by default would crash every client on
 * deploy. A JS array with an extra `nextCursor` property does not survive
 * JSON.stringify either. So:
 *
 *   default (no `format` param)  -> a bare JSON array, byte-for-byte the old
 *                                   shape, with pagination metadata in the
 *                                   `X-Next-Cursor` / `X-Has-More` response
 *                                   headers.
 *   ?format=envelope             -> { data, nextCursor, hasMore }
 *
 * Old clients keep working untouched; new clients opt in to the envelope and
 * never have to read headers. Both are served by the same query.
 *
 * Defaults are deliberately bounded: active orders only (no DELIVERED) and
 * DEFAULT_ORDER_PAGE_SIZE rows. `?active=true` is still accepted and is now
 * simply the default, so existing callers change nothing.
 */
adminOrdersRouter.get("/", requireAuth("ADMIN"), async (c) => {
  const query = listQuerySchema.parse({
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    status: c.req.query("status"),
  });

  // `active=false` is the only way to ask for delivered orders too; anything
  // else (including the param being absent) keeps the board on live work.
  const includeDelivered = c.req.query("active") === "false";

  const statuses = query.status
    ? query.status
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is (typeof ORDER_STATUSES)[number] =>
          (ORDER_STATUSES as readonly string[]).includes(s),
        )
    : undefined;

  if (query.status && (!statuses || statuses.length === 0)) {
    throw new ApiError(400, "INVALID_STATUS", `status must be one or more of ${ORDER_STATUSES.join(", ")}`);
  }

  const pool = getRequestPool(c);
  const user = c.get("user")!;

  const page = await getAllOrders(pool, {
    kitchen: user.kitchen || undefined,
    statuses,
    includeDelivered,
    cursor: query.cursor,
    limit: query.limit ?? DEFAULT_ORDER_PAGE_SIZE,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  });

  const serialized = page.data.map((order) => ({
    ...order,
    totalAmount: Number(order.totalAmount).toFixed(2),
  }));

  c.header("X-Next-Cursor", page.nextCursor ?? "");
  c.header("X-Has-More", String(page.hasMore));
  // Without this the browser cannot read either header cross-origin, which
  // would leave a paginating frontend unable to fetch page 2.
  c.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-More");

  if (c.req.query("format") === "envelope") {
    return c.json({ data: serialized, nextCursor: page.nextCursor, hasMore: page.hasMore });
  }
  return c.json(serialized);
});

adminOrdersRouter.get("/stats", requireAuth("ADMIN"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const stats = await getAdminStats(pool, user.kitchen || undefined, user.school);
  return c.json(stats);
});

adminOrdersRouter.get("/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const order = await openOrderForAdmin(pool, id, user.id, user.kitchen || undefined);
  // Broadcasting "seen" to the rest of the kitchen board is a side effect for
  // OTHER admins' screens, not something the clicking admin's own response
  // depends on. Blocking their response on that Durable Object round-trip
  // was pure added latency; waitUntil lets it finish after the response is
  // already on the wire. (Falls back to a blocking await if executionCtx
  // isn't available, e.g. the Node test harness.)
  const seenPromise = emitOrderSeen(getBindings(c), {
    orderId: order.id,
    kitchen: order.kitchen,
    seenByAdmin: true,
    lockedByAdminId: user.id,
  });
  // c.executionCtx is a getter that throws outside Workers (the Node test
  // harness has none) rather than returning undefined, so this needs a
  // try/catch rather than optional chaining.
  try {
    c.executionCtx.waitUntil(seenPromise);
  } catch {
    await seenPromise;
  }
  return c.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
});

adminOrdersRouter.patch("/:id/status", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const { status } = statusBodySchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const order = await updateOrderStatus(pool, id, status, user.kitchen || undefined);
  if (!user.kitchen || user.kitchen !== order.kitchen) {
    await logAction(pool, user.id, "ORDER_STATUS_OVERRIDE", "Order", order.id, { kitchen: order.kitchen, status });
  }
  const bindings = getBindings(c);
  // Everything below is a notification to someone OTHER than the admin who
  // just clicked "Food collected" — the kitchen board's other viewers, the
  // order owner's live tracker, Telegram. None of it changes what this
  // response says, and the admin's flow chains two of these PATCHes back to
  // back (COOKED then DELIVERED), so blocking each one on an SSE broadcast +
  // a live Telegram API call was pure added latency on the hot path.
  // waitUntil lets it all finish after the response is already on the wire.
  const notify = async () => {
    // One call emits both the kitchen-board patch and the owner's personal
    // notification. The owner is a student OR a walk-up guest session — a
    // guest watching the counter screen needs their push as much as a
    // student does.
    await emitOrderStatusChanged(bindings, {
      orderId: order.id,
      status: order.status,
      kitchen: order.kitchen,
      orderNumber: order.orderNumber,
      deliveredAt: order.deliveredAt,
      subjectId: order.studentId ?? guestSubjectIdOrNull(order.guestSessionId),
    });
    await notifyStudentOrderTelegram(pool, bindings, {
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
    if (status === "DELIVERED") {
      // Stock is only decremented on delivery, so this is the one place a
      // real stock delta exists. Absolute levels, never diffs.
      await emitStockChanged(
        bindings,
        order.items.map((i) => ({
          menuItemId: i.menuItemId,
          stockQty: i.menuItem.stockQty,
          isAvailable: i.menuItem.isAvailable,
          kitchen: order.kitchen,
        }))
      );
    }
  };
  // c.executionCtx is a getter that throws outside Workers (the Node test
  // harness has none) rather than returning undefined, so this needs a
  // try/catch rather than optional chaining.
  try {
    c.executionCtx.waitUntil(notify());
  } catch {
    await notify();
  }
  return c.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
});
