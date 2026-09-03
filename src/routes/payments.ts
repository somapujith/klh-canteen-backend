import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { getBindings, getRequestPool } from "../lib/context.js";
import { ApiError } from "../middleware/errorHandler.js";
import { logAction } from "../services/auditService.js";
import {
  applyWebhook,
  expireStalePayments,
  getPaymentConfig,
  getPaymentForOwner,
  initiatePayment,
  paymentsEnabled,
  releaseUnpaidOrders,
  recordWebhook,
  recordWebhookOutcome,
  reconcileWithGateway,
  verifyWebhook,
  type PaymentRow,
  type WebhookPayload,
  type SettlementResult,
} from "../services/paymentService.js";
import { emitOrderCreated, emitStockChanged } from "../services/sseService.js";
import { notifyStudentOrderTelegram } from "../services/telegramService.js";
import { toOrderSummary } from "../lib/orderSummary.js";
import { verifyGuestSession } from "../services/guestSessionService.js";
import { sql, query } from "../db/sql.js";
import type { AppEnv } from "../types.js";

/**
 * UPI payment endpoints.
 *
 * Callers: mounted from app.ts at /payments.
 * Endpoints:
 *   POST /payments/checkout      (STUDENT or guest session) — open a payment
 *   GET  /payments/:id           (owner only)               — poll status
 *   POST /payments/webhook       (public, signature-verified) — settle
 *
 * The webhook is the only public route here, and it authenticates by HMAC
 * signature rather than by session — see the note above the handler.
 */
export const paymentsRouter = new Hono<AppEnv>();

const GUEST_SESSION_HEADER = "X-Guest-Session";

/** Serialised payment, minus anything the owner has no use for. The webhook
 *  secret never touches this file, but the QR payload is large and only worth
 *  sending while the payment can still be completed. */
function serializePayment(payment: PaymentRow, includeQr: boolean) {
  return {
    id: payment.id,
    status: payment.status,
    amount: Number(payment.amount).toFixed(2),
    currency: payment.currency,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    paidAt: payment.paidAt?.toISOString() ?? null,
    upiTxnId: payment.upiTxnId,
    payerVpa: payment.payerVpa,
    failureReason: payment.failureReason,
    ...(includeQr
      ? { qrCode: payment.qrCode, upiString: payment.upiString }
      : {}),
  };
}

/**
 * Resolves the caller as either an authenticated student or a valid guest
 * session, and refuses anyone who is neither.
 *
 * Payments are open to both because ordering is: a walk-up guest with a
 * session must be able to pay for the cart they just placed. The guest branch
 * verifies the signed session exactly as routes/guest.ts does rather than
 * trusting the header.
 */
function resolveOwner(c: Context<AppEnv>): { studentId?: string; guestSessionId?: string } {
  const user = c.get("user");
  if (user) return { studentId: user.id };

  // Same two shapes routes/guest.ts accepts, so a guest client needs no
  // special-casing for the payment endpoints.
  const header = c.req.header(GUEST_SESSION_HEADER);
  const authHeader = c.req.header("Authorization");
  const token = header || (authHeader?.startsWith("Guest ") ? authHeader.slice(6) : "");
  if (!token) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in or start a guest session to pay.");
  }

  const { QR_TOKEN_SECRET } = getBindings(c);
  const sessionId = verifyGuestSession(token, QR_TOKEN_SECRET);
  if (!sessionId) {
    throw new ApiError(401, "INVALID_GUEST_SESSION", "Guest session is invalid or has expired");
  }
  return { guestSessionId: sessionId };
}

/**
 * Attaches the student when a Bearer token is present, and otherwise lets the
 * request through unauthenticated so resolveOwner can try the guest branch.
 *
 * requireAuth() cannot express this — it refuses an anonymous request outright
 * — and these routes must serve both an enrolled student and a walk-up guest.
 * A malformed or expired token is NOT quietly ignored: it still fails, because
 * silently downgrading a bad student token to "anonymous" would turn an auth
 * error into a confusing 401 from the guest branch instead.
 */
const optionalStudentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return next();
  return requireAuth("STUDENT")(c, next);
};

/**
 * Whether a stored value is usable as an email address for the gateway.
 *
 * Deliberately a shape check, not validation: the only question is whether
 * SafeUPI will accept it, and the cost of a false negative is a placeholder
 * address rather than a failed payment.
 */
function looksLikeEmail(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const checkoutSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(4),
});

const checkoutLimiter = rateLimit({
  prefix: "payments-checkout",
  windowSeconds: 60,
  max: 10,
  code: "TOO_MANY_REQUESTS",
  message: "Too many payment attempts, please wait a minute.",
});

/**
 * Opens a payment for orders that are already placed and holding stock.
 *
 * Split from order creation on purpose: the orders exist and their portions
 * are reserved before any money is involved, so a gateway failure costs a
 * cancelled order rather than a student who was charged for food that had
 * already sold out.
 */
paymentsRouter.post("/checkout", optionalStudentAuth, checkoutLimiter, async (c) => {
  const bindings = getBindings(c);
  if (!paymentsEnabled(bindings)) {
    throw new ApiError(503, "PAYMENTS_DISABLED", "Online payment is not available right now.");
  }

  const { orderIds } = checkoutSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const owner = resolveOwner(c);

  // Names on the gateway's receipt. Read from our own records rather than
  // accepted from the request: a student does not get to decide what name
  // appears against a transaction.
  let customerName = "Customer";
  let customerMobile: string | undefined;
  let customerEmail: string | undefined;
  if (owner.studentId) {
    const { rows } = await query<{ name: string | null; email: string | null }>(
      pool,
      sql`SELECT "name", "email" FROM "User" WHERE "id" = ${owner.studentId}::text LIMIT 1`,
    );
    customerName = rows[0]?.name || "Customer";
    // Only forwarded when it actually looks like an address.
    //
    // User.email doubles as the login identifier, and most student accounts
    // hold a bare username there rather than an email — 154 of them at the
    // time of writing, which is the majority. Passing one straight through
    // earned a `422 Valid customer email is required` from SafeUPI and a 502
    // at checkout, i.e. most students could not pay at all. Anything that is
    // not address-shaped is treated as absent so the placeholder below is
    // used instead.
    customerEmail = looksLikeEmail(rows[0]?.email) ? rows[0]!.email! : undefined;
  } else {
    const { rows } = await query<{ guestName: string | null; guestPhone: string | null }>(
      pool,
      sql`
        SELECT "guestName", "guestPhone" FROM "Order"
         WHERE "id" = ANY(${orderIds}::text[]) AND "guestSessionId" = ${owner.guestSessionId}::text
         LIMIT 1
      `,
    );
    customerName = rows[0]?.guestName || "Guest";
    // The gateway wants exactly ten digits; anything else is dropped rather
    // than sent and rejected.
    const digits = (rows[0]?.guestPhone ?? "").replace(/\D/g, "");
    if (digits.length === 10) customerMobile = digits;
  }

  let payment;
  try {
    payment = await initiatePayment(pool, bindings, {
      orderIds,
      owner: { ...owner, customerName, customerMobile, customerEmail },
      productInfo: "Canteen order",
    });
  } catch (err) {
    // The orders were written before the gateway was called, so that stock is
    // held while the student pays. No payment ever opened against them, so
    // holding that food for the full reservation TTL would take it off sale for
    // hours over a failure the student cannot do anything about. Hand it back
    // now and let them retry with a clean cart.
    //
    // Best-effort: the original failure is what the student needs to hear, so a
    // problem releasing must not replace it with a different error.
    await releaseUnpaidOrders(pool, orderIds).catch((releaseErr) =>
      console.error("[payments] failed to release orders after a failed checkout", releaseErr),
    );
    throw err;
  }

  if (owner.studentId) {
    await logAction(pool, owner.studentId, "PAYMENT_INITIATED", "Payment", payment.paymentId, {
      amount: payment.amount,
      orderIds,
      gatewayOrderId: payment.gatewayOrderId,
    });
  }

  return c.json(
    {
      paymentId: payment.paymentId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      expiresAt: payment.expiresAt.toISOString(),
      // Where the client sends the student. Under the hosted-page flow this is
      // the entire payment UI, so it is the one field the client cannot do
      // without.
      paymentUrl: payment.paymentUrl,
      // Returned only for selected businesses, so usually null. Passed through
      // for a desktop user who would rather scan than be redirected; the hosted
      // page renders its own QR either way.
      qrCode: payment.qrCode,
      orderIds,
    },
    201,
  );
});

const statusLimiter = rateLimit({
  prefix: "payments-status",
  windowSeconds: 60,
  // The client polls this every couple of seconds for up to two minutes while
  // the student is paying, so the ceiling is well above the order limiter's.
  max: 90,
  code: "TOO_MANY_REQUESTS",
  message: "Too many status checks, please slow down.",
});

/**
 * Floor between two live gateway reconciliation calls for the SAME payment.
 *
 * The endpoint above is polled far more often than this — every 2s from the
 * client — but there is no reason to ask SafeUPI the same question that
 * often: observed confirmation times for this merchant range from ~20s to
 * 500s+, so a fresh answer every 5s already tracks their pace closely without
 * multiplying request volume by roughly 2.5x for no benefit.
 */
const RECONCILE_MIN_INTERVAL_MS = 5_000;

/**
 * Where the client waits while the student pays.
 *
 * A still-PENDING payment triggers a reconciliation call to the gateway,
 * because the webhook is not guaranteed: if that delivery was dropped, this
 * poll is what discovers the payment actually succeeded. Any settlement it
 * finds runs through the same applyWebhook path a real delivery would, so
 * there is exactly one implementation of "what happens when money arrives".
 */
paymentsRouter.get("/:id", optionalStudentAuth, statusLimiter, async (c) => {
  const bindings = getBindings(c);
  const pool = getRequestPool(c);
  const paymentId = z.string().uuid().parse(c.req.param("id"));
  const owner = resolveOwner(c);

  let payment = await getPaymentForOwner(pool, paymentId, owner);
  if (!payment) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  if (payment.status === "PENDING" && paymentsEnabled(bindings)) {
    // Past its window and still undecided: close it out rather than asking the
    // gateway about a QR nobody can scan any more.
    if (payment.expiresAt && payment.expiresAt.getTime() < Date.now()) {
      await expireStalePayments(pool);
    } else if (Date.now() - payment.updatedAt.getTime() >= RECONCILE_MIN_INTERVAL_MS) {
      // Throttled to one live gateway call per interval, not one per poll.
      // The frontend polls every 2s and a slow settlement can run for minutes
      // — unthrottled, that is roughly 250+ calls to SafeUPI asking the same
      // question the webhook will eventually answer anyway. It never shortens
      // their confirmation time (that delay is entirely on their side) and
      // needlessly hammers their API, which for all we know is itself part of
      // why their reconciliation is slow and inconsistent for this merchant.
      try {
        const settled = await reconcileWithGateway(pool, bindings, payment);
        if (settled?.changed) await broadcastSettlement(c, settled);
      } catch (err) {
        // A gateway hiccup must not break the poll — the client simply sees
        // PENDING and asks again, and the webhook may still land.
        console.warn("[payments] reconciliation failed", paymentId, err);
      }
    }
    payment = (await getPaymentForOwner(pool, paymentId, owner)) ?? payment;
  }

  return c.json(serializePayment(payment, payment.status === "PENDING"));
});

/**
 * Gateway webhook.
 *
 * PUBLIC — and deliberately so. The caller is SafeUPI's servers rather than a
 * browser, so there is no session to authenticate against.
 *
 * WHAT AUTHENTICATES IT, AND WHY THAT IS NOT ENOUGH. SafeUPI does not sign its
 * webhooks; it echoes a shared secret in the request body. That is a bearer
 * check: it says the sender knew the secret, and nothing at all about whether
 * the payload is true. Anything that ever sees one delivery — a log line, a
 * proxy, a misdirected request — learns the secret and can then forge a
 * "success" for any order it can name.
 *
 * So the secret only buys the caller the right to be listened to. Before a
 * single order is released, applyWebhook independently asks SafeUPI's Status
 * API what actually happened, and the gateway's answer overrides whatever the
 * payload claimed. Forging a delivery is therefore not enough on its own.
 *
 * A verified delivery is always answered 200, even when it changed nothing:
 * SafeUPI retries anything else, and a duplicate we correctly ignored is not a
 * failure worth retrying.
 */
paymentsRouter.post("/webhook", async (c) => {
  const bindings = getBindings(c);
  if (!paymentsEnabled(bindings)) {
    // Nothing to settle against. 200 rather than an error so the gateway does
    // not retry a delivery this deployment will never accept.
    return c.json({ received: true, ignored: "payments disabled" }, 200);
  }

  const config = getPaymentConfig(bindings);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Malformed payload" }, 400);
  }
  if (typeof payload !== "object" || payload === null) {
    return c.json({ error: "Malformed payload" }, 400);
  }

  const body = payload as { secret?: unknown };
  const verification = verifyWebhook(config.webhookSecret, body.secret);
  const pool = getRequestPool(c);

  /**
   * Record the delivery before acting on it.
   *
   * A payment that fails "somewhere between the UPI app and the order" is
   * otherwise unanswerable after the fact — the request body is the only
   * evidence of what SafeUPI actually said, and it is gone once the request
   * ends. Written for rejected deliveries too: a run of unauthenticated ones
   * means either someone is probing the endpoint or the dashboard secret has
   * drifted from ours, and both are invisible without this.
   *
   * The secret is stripped first. It is a bearer credential, and storing it
   * would put in the database exactly the value that lets anyone forge a
   * settlement.
   */
  await recordWebhook(pool, payload, verification.ok, null);

  if (!verification.ok) {
    // Logged without the body: an unverified payload is attacker-controlled,
    // and in this scheme the body carries a credential — logging it would leak
    // the very secret being checked.
    console.warn("[payments] rejected webhook:", verification.reason);
    return c.json({ error: "Unauthorized" }, 401);
  }

  // `config` is what turns on the Status API confirmation — see applyWebhook.
  const result = await applyWebhook(pool, payload as WebhookPayload, { config });
  await recordWebhookOutcome(pool, payload, result.status ?? result.reason ?? null);

  if (!result.changed) {
    // Duplicate, unmatched, or already terminal. All are 200: the delivery was
    // genuine and there is nothing for the gateway to retry.
    console.info("[payments] webhook no-op:", result.reason);
    return c.json({ received: true }, 200);
  }

  await broadcastSettlement(c, result);
  return c.json({ received: true }, 200);
});

/**
 * Pushes a settlement out to everyone watching.
 *
 * Confirmed orders appear on the kitchen board for the first time here — they
 * were hidden while awaiting payment — so this emits the same
 * order-created frame that routes/orders.ts emits for an unpaid-flow order.
 * Released orders hand their stock back, so the menu is told too.
 *
 * Every step is best-effort: the money is already settled and the database
 * already reflects it, so a failed broadcast must never turn into a non-200
 * that makes the gateway retry a completed settlement.
 */
async function broadcastSettlement(c: any, result: SettlementResult): Promise<void> {
  const bindings = getBindings(c);
  const pool = getRequestPool(c);

  try {
    if (result.confirmedOrderIds.length > 0) {
      const { rows } = await query<any>(
        pool,
        sql`
          SELECT o."id", o."orderNumber", o."status", o."kitchen", o."totalAmount",
                 o."createdAt", o."collectionAt", o."seenByAdmin", o."studentId",
                 o."guestName",
                 u."name" AS "studentName", u."rollNumber" AS "rollNumber",
                 (SELECT COUNT(*)::int FROM "OrderItem" oi WHERE oi."orderId" = o."id") AS "itemCount"
            FROM "Order" o
            LEFT JOIN "User" u ON u."id" = o."studentId"
           WHERE o."id" = ANY(${result.confirmedOrderIds}::text[])
        `,
      );

      await emitOrderCreated(
        bindings,
        rows.map((row) =>
          toOrderSummary({
            ...row,
            student: { name: row.studentName, rollNumber: row.rollNumber },
            // toOrderSummary counts items from the array's length; the count
            // was aggregated in SQL rather than joining every line back.
            items: new Array(Number(row.itemCount)),
          }),
        ),
      );

      // Student-only Telegram order log, matching the unpaid flow's.
      for (const row of rows) {
        if (!row.studentId) continue;
        const { rows: lines } = await query<{ name: string; quantity: number }>(
          pool,
          sql`
            SELECT mi."name", oi."quantity"
              FROM "OrderItem" oi
              JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
             WHERE oi."orderId" = ${row.id}::text
          `,
        );
        await notifyStudentOrderTelegram(pool, bindings, {
          studentId: row.studentId,
          orderNumber: row.orderNumber,
          status: row.status,
          kitchen: row.kitchen,
          totalAmount: String(row.totalAmount),
          items: lines.map((l) => ({ name: l.name, quantity: l.quantity })),
          kind: "created",
        });
      }
    }

    // A released order gave its portions back, so every open menu needs the
    // new sellable level.
    const touched = [...result.confirmedOrderIds, ...result.releasedOrderIds];
    if (result.releasedOrderIds.length > 0 && touched.length > 0) {
      const { rows: stock } = await query<{ id: string; stockQty: number; reservedQty: number }>(
        pool,
        sql`
          SELECT DISTINCT mi."id", mi."stockQty", mi."reservedQty"
            FROM "MenuItem" mi
            JOIN "OrderItem" oi ON oi."menuItemId" = mi."id"
           WHERE oi."orderId" = ANY(${result.releasedOrderIds}::text[])
        `,
      );
      if (stock.length > 0) {
        await emitStockChanged(
          bindings,
          stock.map((item) => ({
            menuItemId: item.id,
            stockQty: Math.max(0, item.stockQty - item.reservedQty),
          })),
        );
      }
    }
  } catch (err) {
    console.error("[payments] settlement broadcast failed", err);
  }
}
