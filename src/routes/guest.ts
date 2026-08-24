import { Hono } from "hono";
import { z } from "zod";
import type { MiddlewareHandler } from "hono";
import {
  createOrder,
  getGuestOrders,
  getOrderForGuest,
  getCollectionWindows,
  MAX_PREBOOK_DAYS,
} from "../services/orderService.js";
import { issueGuestSession, verifyGuestSession } from "../services/guestSessionService.js";
import { emitOrderCreated } from "../services/sseService.js";
import { toOrderSummary } from "../lib/orderSummary.js";
import { getBindings, getRequestPrisma } from "../lib/context.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { AppEnv } from "../types.js";

/**
 * Walk-up guest ordering: staff scan a printed QR at the counter, browse,
 * pay, collect. No account, no login, no roll number.
 *
 * SECURITY MODEL — the whole point of this router
 * A guest holds a signed session token and nothing else. It proves only
 * "I am the session that placed these orders". Therefore:
 *
 *   - there is NO endpoint here that lists orders across sessions, and none
 *     that reads an order by id alone;
 *   - every read passes the session id into the query's WHERE clause
 *     (getGuestOrders / getOrderForGuest), exactly as the student routes pass
 *     studentId — ownership is a predicate, never a post-filter;
 *   - a guest asking for someone else's order id gets the same 404 as one
 *     asking for an id that does not exist, so the endpoint cannot be used to
 *     probe which orders exist.
 *
 * The session id is only ever read back out of a verified HMAC. It is never
 * accepted as a plain request parameter, which is what would turn it from an
 * unforgeable key into an enumerable one.
 */
export const guestRouter = new Hono<AppEnv>();

const GUEST_SESSION_HEADER = "X-Guest-Session";

declare module "hono" {
  interface ContextVariableMap {
    guestSessionId?: string;
  }
}

/**
 * Recovers and verifies the caller's guest session, or refuses the request.
 * Nothing downstream may read a session id from anywhere else.
 */
const requireGuestSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header(GUEST_SESSION_HEADER);
  const authHeader = c.req.header("Authorization");
  const token = header || (authHeader?.startsWith("Guest ") ? authHeader.slice(6) : "");

  if (!token) {
    throw new ApiError(401, "NO_GUEST_SESSION", `Missing ${GUEST_SESSION_HEADER} header`);
  }

  const { QR_TOKEN_SECRET } = getBindings(c);
  const sessionId = verifyGuestSession(token, QR_TOKEN_SECRET);
  if (!sessionId) {
    throw new ApiError(401, "INVALID_GUEST_SESSION", "Guest session is invalid or has expired");
  }

  c.set("guestSessionId", sessionId);
  await next();
};

/**
 * Keyed on the verified session id, never on anything the caller can pick
 * freely — an attacker-chosen key would let one client spread its traffic
 * across unlimited buckets. "reject" is safe for the same reason: a guest
 * cannot mint a session id belonging to someone else and lock them out.
 */
const guestOrderLimiter = rateLimit({
  prefix: "guest-orders",
  windowSeconds: 60,
  max: 5,
  keyFn: (c) => {
    const sessionId = c.get("guestSessionId");
    return sessionId ? `g:${sessionId}` : null;
  },
  code: "TOO_MANY_ORDERS",
  message: "Too many orders placed, please wait a minute.",
});

// Prisma's Decimal.toJSON() drops trailing zeros ("20.00" -> "20"). Match the
// student routes and pin money to a fixed 2-decimal string at the boundary.
function serializeOrder<T extends { totalAmount: unknown; items: { priceAtOrder: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: Number(order.totalAmount).toFixed(2),
    orderNumber: (order as any).orderNumber,
    items: order.items.map((item) => ({
      ...item,
      priceAtOrder: Number(item.priceAtOrder).toFixed(2),
    })),
    // The session id is the guest's bearer key. It is never echoed back in a
    // response body, where it would end up in logs and screenshots.
    guestSessionId: undefined,
  };
}

/**
 * Mints a fresh guest session. Deliberately unauthenticated — that is the
 * entry point for someone who has just scanned the printed counter QR.
 * Volumetric abuse of this route is an edge/WAF concern (see the note in
 * middleware/rateLimit.ts): there is no identity to key an app-level limit
 * on yet, and the token it returns grants access to nothing that exists.
 */
guestRouter.post("/session", async (c) => {
  const { QR_TOKEN_SECRET } = getBindings(c);
  const session = issueGuestSession(QR_TOKEN_SECRET);
  return c.json(
    {
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      expiresInSeconds: session.expiresInSeconds,
      // Send this back on every later call.
      header: GUEST_SESSION_HEADER,
    },
    201,
  );
});

const createGuestOrderSchema = z.object({
  items: z.array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1) })).min(1),
  /** Optional — a name to call out at the counter, not an identity. */
  guestName: z.string().trim().min(1).max(60).optional(),
  guestPhone: z.string().trim().min(4).max(20).optional(),
  /** Absent means "as soon as possible". */
  collectionAt: z.string().datetime({ offset: true }).optional(),
});

guestRouter.post("/orders", requireGuestSession, guestOrderLimiter, async (c) => {
  const body = createGuestOrderSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const bindings = getBindings(c);
  const guestSessionId = c.get("guestSessionId")!;

  const orders = await createOrder(prisma, bindings.QR_TOKEN_SECRET, {
    owner: {
      guestSessionId,
      guestName: body.guestName ?? null,
      guestPhone: body.guestPhone ?? null,
    },
    items: body.items,
    collectionAt: body.collectionAt ? new Date(body.collectionAt) : null,
  });

  await emitOrderCreated(bindings, orders.map(toOrderSummary));
  return c.json(orders.map(serializeOrder), 201);
});

/** This session's orders only. Scoped in the WHERE clause, not filtered after. */
guestRouter.get("/orders", requireGuestSession, async (c) => {
  const prisma = getRequestPrisma(c);
  const orders = await getGuestOrders(prisma, c.get("guestSessionId")!);
  return c.json(orders.map(serializeOrder));
});

const windowsQuerySchema = z.object({
  kitchen: z.enum(["SNACKS", "MEALS"]),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

// Registered before "/orders/:id" so the literal path is not captured by the
// id parameter.
guestRouter.get("/collection-windows", requireGuestSession, async (c) => {
  const { kitchen, from, to } = windowsQuerySchema.parse({
    kitchen: c.req.query("kitchen"),
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  const prisma = getRequestPrisma(c);
  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : new Date(Date.now() + MAX_PREBOOK_DAYS * 24 * 60 * 60 * 1000);
  return c.json(await getCollectionWindows(prisma, kitchen, fromDate, toDate));
});

/**
 * Status polling for one of this session's own orders. Guests have no SSE
 * connection (that route requires a JWT), so polling here is how a guest
 * watches their order — and it can only ever surface their own.
 */
guestRouter.get("/orders/:id", requireGuestSession, async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const order = await getOrderForGuest(prisma, id, c.get("guestSessionId")!);
  return c.json(serializeOrder(order));
});
