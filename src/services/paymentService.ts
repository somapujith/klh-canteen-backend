import type { Pool, PoolClient } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import { sql, query } from "../db/sql.js";
import type { Bindings } from "../types.js";

/** Anything that can run a query — a Pool, or a PoolClient inside a
 *  transaction. Mirrors the same alias in orderService.ts. */
type RawRunner = Pick<Pool | PoolClient, "query">;

/**
 * UPI payments through GuruPay.
 *
 * Callers: routes/payments.ts (checkout, status poll, webhook).
 * Shape: one Payment covers a whole cart, which createOrder may have split
 * into one Order per kitchen — so the FK sits on Order and a settlement fans
 * out to every order carrying this paymentId.
 *
 * Nothing here trusts the client for money. The amount charged is recomputed
 * from the orders we wrote, and the amount GuruPay reports is checked against
 * it again before a single order is released.
 *
 * GuruPay does not sign its webhooks at all — there is no shared secret, no
 * header to check, nothing that distinguishes a genuine delivery from a POST
 * anyone could send by hand. So a webhook here is treated as pure noise: a
 * HINT that something MIGHT have happened, and nothing more. Every
 * settlement that releases food is decided ONLY by independently calling
 * GuruPay's own check-status endpoint — the payload is used solely to look
 * up which payment to ask about, never to decide its outcome. Forging a
 * delivery therefore accomplishes nothing on its own; an attacker would also
 * have to make GuruPay's own records say "success".
 */

const GATEWAY_BASE_URL = "https://www.gurupaygateway.com/api";

/**
 * How long a payment is held open before it is closed out as expired.
 *
 * GuruPay does not document a checkout expiry for its hosted page, so this is
 * our own bound rather than a mirror of theirs. Fifteen minutes is chosen to
 * be comfortably longer than a student fumbling with a UPI PIN, while still
 * returning the food to the counter the same lunch hour if they wander off.
 */
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

/** Rupee bounds. GuruPay documents only "amount > 0.00", so these are our own
 *  sanity rails: a zero-rupee order is a bug, and a five-figure canteen bill
 *  is far more likely to be one than a real lunch. */
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 100_000;

export type PaymentStatus = "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED";

export interface PaymentRow {
  id: string;
  clientTxnId: string;
  gatewayOrderId: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  studentId: string | null;
  guestSessionId: string | null;
  upiTxnId: string | null;
  payerVpa: string | null;
  payerName: string | null;
  /** GuruPay's hosted checkout page — where the student is sent to pay. */
  paymentUrl: string | null;
  /**
   * Whether this payment's outcome was confirmed against GuruPay's
   * check-status API rather than believed from the webhook signature alone.
   * Recorded so "we checked" is a fact worth being able to audit.
   */
  verifiedViaStatusApi: boolean;
  expiresAt: Date | null;
  paidAt: Date | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  webhookCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PaymentConfig {
  /** GuruPay's merchant API key, sent as the `X-Guru-Key` header. */
  apiKey: string;
  /** Where GuruPay returns the student's browser after the hosted page. */
  redirectUrl: string;
}

/**
 * True only when payments are switched on AND fully configured.
 *
 * Deliberately two conditions: a half-configured deploy (flag on, key
 * missing) must not present a checkout that cannot settle. It reads as "off"
 * instead, which is the safe direction — ordering still works.
 */
export function paymentsEnabled(bindings: Bindings): boolean {
  if (String(bindings.PAYMENTS_ENABLED ?? "").toLowerCase() !== "true") return false;
  return Boolean(bindings.GURUPAY_API_KEY && bindings.GURUPAY_REDIRECT_URL);
}

/**
 * Config or a hard failure. Called only behind paymentsEnabled(), so a throw
 * here means the flag was flipped on without the key — worth a 503 that names
 * the cause rather than a confusing gateway error later.
 */
export function getPaymentConfig(bindings: Bindings): PaymentConfig {
  const apiKey = bindings.GURUPAY_API_KEY;
  const redirectUrl = bindings.GURUPAY_REDIRECT_URL;

  if (!apiKey || !redirectUrl) {
    throw new ApiError(
      503,
      "PAYMENTS_UNCONFIGURED",
      "Payments are not configured. Set GURUPAY_API_KEY and GURUPAY_REDIRECT_URL.",
    );
  }
  return { apiKey, redirectUrl };
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

/** GuruPay's response envelope: `{ status, data }`, with `message` on errors. */
interface GatewayEnvelope<T> {
  status: string;
  message?: string;
  data?: T;
}

/** POST /api/create-order */
interface CreateOrderData {
  payment_url: string;
  order_id: string;
  token: string;
  amount: number | string;
  currency: string;
}

/** POST /api/check-status */
interface CheckStatusData {
  order_id: string;
  amount: number | string;
  currency: string;
  payment_status: string;
  utr: string | null;
  payment_method?: string;
  provider?: string;
  gateway_txn_id?: string | null;
  paid_at?: string | null;
}

/** Capped well under the payment window: a hung connection must not hold a
 *  request open until the order it is paying for has already expired. */
const GATEWAY_TIMEOUT_MS = 15_000;

/**
 * One GuruPay call.
 *
 * The API key rides in the `X-Guru-Key` header, GuruPay's documented scheme —
 * a meaningfully better place for a credential than SafeUPI's body field was
 * (bodies are what get logged and echoed back in error reports). Even so,
 * nothing in this module logs a request body, only responses, since there is
 * no benefit to loosening that discipline now.
 */
async function callGateway<T>(
  config: PaymentConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<GatewayEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Guru-Key": config.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout. 502, not 500: the fault is upstream, and the
    // distinction is what tells us where to look when this shows up in logs.
    console.error("[payments] gateway request failed", path, err);
    throw new ApiError(
      502,
      "PAYMENT_GATEWAY_UNREACHABLE",
      "Could not reach the payment gateway. Please try again.",
    );
  }

  const text = await response.text();
  let parsed: GatewayEnvelope<T>;
  try {
    parsed = JSON.parse(text) as GatewayEnvelope<T>;
  } catch {
    console.error("[payments] gateway returned non-JSON", path, response.status, text.slice(0, 500));
    throw new ApiError(502, "PAYMENT_GATEWAY_ERROR", "The payment gateway returned an unreadable response.");
  }

  // GuruPay signals failure with a non-"success" status and may still answer
  // HTTP 200, so the envelope is authoritative rather than the status code.
  if (!response.ok || parsed.status !== "success") {
    console.error("[payments] gateway rejected request", path, response.status, parsed.message ?? "(no reason given)");
    const status = response.status === 429 ? 429 : 502;
    throw new ApiError(
      status,
      "PAYMENT_GATEWAY_REJECTED",
      parsed.message ?? "The payment gateway rejected the request.",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Payment lifecycle
// ---------------------------------------------------------------------------

function assertChargeable(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, "INVALID_AMOUNT", "Order total is not a payable amount.");
  }
  if (amount < MIN_AMOUNT) {
    throw new ApiError(400, "AMOUNT_TOO_LOW", `Minimum payable amount is ${MIN_AMOUNT} rupee.`);
  }
  if (amount > MAX_AMOUNT) {
    throw new ApiError(400, "AMOUNT_TOO_HIGH", `Maximum payable amount is ${MAX_AMOUNT} rupees.`);
  }
}

/**
 * Our transaction reference. Random rather than derived from the payment id,
 * so a retry after a failed create-order gets a fresh reference — GuruPay
 * treats order_id as unique and would reject the reuse.
 */
function newClientTxnId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `KLH${Date.now().toString(36).toUpperCase()}${out.toUpperCase()}`;
}

export interface PaymentOwner {
  studentId?: string;
  guestSessionId?: string;
  customerName?: string;
  customerMobile?: string;
}

export interface InitiatedPayment {
  paymentId: string;
  clientTxnId: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  expiresAt: Date;
  /**
   * GuruPay's hosted checkout page. The client sends the student here; this is
   * the whole of the payment UI under the hosted-page flow.
   */
  paymentUrl: string;
}

/**
 * Opens a payment for orders that are already written and holding stock.
 *
 * The amount is summed from the order rows, never taken from the caller: the
 * client has no say in what it is charged.
 */
export async function initiatePayment(
  pool: Pool,
  bindings: Bindings,
  input: { orderIds: string[]; owner: PaymentOwner; productInfo?: string },
): Promise<InitiatedPayment> {
  const config = getPaymentConfig(bindings);
  const { orderIds, owner } = input;

  if (orderIds.length === 0) {
    throw new ApiError(400, "NO_ORDERS", "No orders to pay for.");
  }
  if (Boolean(owner.studentId) === Boolean(owner.guestSessionId)) {
    throw new ApiError(400, "INVALID_OWNER", "A payment belongs to exactly one student or guest session.");
  }

  // Sum from the ledger, and only over orders genuinely awaiting payment and
  // owned by this caller. An order already paid, already cancelled, or
  // belonging to someone else contributes nothing and is not attached — which
  // is what stops one student paying to release another's order, and stops a
  // replayed checkout re-charging for an order that already settled.
  const ownerPredicate = owner.studentId
    ? sql`"studentId" = ${owner.studentId}::text`
    : sql`"guestSessionId" = ${owner.guestSessionId}::text`;

  const { rows: orderRows } = await query<{ id: string; totalAmount: string }>(
    pool,
    sql`
      SELECT "id", "totalAmount"
        FROM "Order"
       WHERE "id" = ANY(${orderIds}::text[])
         AND "awaitingPayment" = TRUE
         AND "paymentId" IS NULL
         AND "status" = 'PENDING'
         AND ${ownerPredicate}
    `,
  );

  if (orderRows.length !== orderIds.length) {
    throw new ApiError(409, "ORDERS_NOT_PAYABLE", "Those orders are no longer awaiting payment.");
  }

  const amount = Number(orderRows.reduce((sum, row) => sum + Number(row.totalAmount), 0).toFixed(2));
  assertChargeable(amount);

  const paymentId = crypto.randomUUID();
  const clientTxnId = newClientTxnId();
  const expiresAt = new Date(Date.now() + PAYMENT_WINDOW_MS);

  // Recorded BEFORE the gateway is called. If create-order succeeds but its
  // response never reaches us, this row still holds the reference we sent — so
  // the webhook that follows can be matched to it, rather than arriving for a
  // payment we have no record of.
  await query(
    pool,
    sql`
      INSERT INTO "Payment" (
        "id", "clientTxnId", "amount", "currency", "status",
        "studentId", "guestSessionId", "expiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${paymentId}::text, ${clientTxnId}::text, ${amount.toFixed(2)}::numeric, 'INR', 'PENDING',
        ${owner.studentId ?? null}::text, ${owner.guestSessionId ?? null}::text,
        ${expiresAt.toISOString()}::timestamp, NOW(), NOW()
      )
    `,
  );

  let data: CreateOrderData;
  try {
    const envelope = await callGateway<CreateOrderData>(config, "/create-order", {
      amount,
      order_id: clientTxnId,
      customer_name: owner.customerName || "Customer",
      customer_mobile: owner.customerMobile,
      // Where GuruPay returns the browser once the hosted page is done. The
      // payment id rides along so the landing page knows which payment to
      // confirm — it is an opaque lookup key, not a credential: the status
      // endpoint it feeds is owner-scoped and hands nothing to a stranger.
      callback_url: `${config.redirectUrl}${config.redirectUrl.includes("?") ? "&" : "?"}payment=${paymentId}`,
      description: input.productInfo ?? "Canteen order",
    });
    if (!envelope.data) {
      throw new ApiError(502, "PAYMENT_GATEWAY_ERROR", "The payment gateway returned no order.");
    }
    data = envelope.data;
  } catch (err) {
    // The gateway never opened. Close the row out so the sweep is not left
    // sitting on a payment that can never settle, and the student can retry.
    await query(
      pool,
      sql`
        UPDATE "Payment"
           SET "status" = 'FAILED',
               "failureReason" = 'gateway create-order failed',
               "updatedAt" = NOW()
         WHERE "id" = ${paymentId}::text
      `,
    ).catch((updateErr) => console.error("[payments] failed to close out unopened payment", updateErr));
    throw err;
  }

  const paymentUrl = data.payment_url;
  if (!paymentUrl) {
    // Without somewhere to send the student there is no payment, so this is a
    // hard failure rather than a half-open row nobody can act on.
    await query(
      pool,
      sql`
        UPDATE "Payment"
           SET "status" = 'FAILED',
               "failureReason" = 'gateway returned no payment url',
               "updatedAt" = NOW()
         WHERE "id" = ${paymentId}::text
      `,
    ).catch(() => {});
    throw new ApiError(502, "PAYMENT_GATEWAY_ERROR", "The payment gateway returned no payment link.");
  }

  await query(
    pool,
    sql`
      UPDATE "Payment"
         SET "paymentUrl" = ${paymentUrl}::text,
             "updatedAt" = NOW()
       WHERE "id" = ${paymentId}::text
    `,
  );

  const { rowCount: attached } = await query(
    pool,
    sql`
      UPDATE "Order"
         SET "paymentId" = ${paymentId}::text
       WHERE "id" = ANY(${orderIds}::text[])
         AND "paymentId" IS NULL
         AND "awaitingPayment" = TRUE
    `,
  );
  if (attached !== orderIds.length) {
    // Not fatal — the payment is open and the webhook settles whatever is
    // attached — but it means an order slipped out from under the checkout
    // between the sum and here, and that is worth seeing in the logs.
    console.error("[payments] order attachment count mismatch", {
      paymentId,
      expected: orderIds.length,
      attached,
    });
  }

  return {
    paymentId,
    clientTxnId,
    amount: amount.toFixed(2),
    currency: "INR",
    status: "PENDING",
    expiresAt,
    paymentUrl,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** A GuruPay webhook delivery. Flatter than SafeUPI's nested `data.*` shape —
 *  GuruPay puts everything at the top level. */
export interface WebhookPayload {
  /** e.g. "payment.success" */
  event?: string;
  order_id?: string;
  amount?: number | string;
  utr?: string | null;
  /** success | pending | failed */
  status?: string;
}

/** Gateway vocabulary to ours. GuruPay documents only three outcomes, unlike
 *  SafeUPI's richer set — anything else is unrecognised. */
function mapGatewayStatus(raw: string | undefined): PaymentStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "success":
      return "SUCCESS";
    case "failed":
      return "FAILED";
    case "pending":
      return "PENDING";
    default:
      return null;
  }
}

export interface SettlementResult {
  /** False when the delivery was a duplicate or arrived for a payment already
   *  in a terminal state — the caller still answers 200, but emits nothing. */
  changed: boolean;
  payment: PaymentRow | null;
  status: PaymentStatus | null;
  /** Orders this settlement confirmed, for the SSE fan-out and Telegram log. */
  confirmedOrderIds: string[];
  /** Orders released because the payment failed or expired. */
  releasedOrderIds: string[];
  reason?: string;
}

/**
 * Finds the payment a webhook is talking about.
 *
 * GuruPay's `order_id` IS our clientTxnId — we chose it, and GuruPay simply
 * echoes it back — so this is a single direct lookup, unlike SafeUPI's
 * three-reference fallback chain (which existed because SafeUPI minted its
 * own separate order id we had to also remember).
 */
async function findPaymentForWebhook(
  db: RawRunner,
  payload: WebhookPayload,
): Promise<PaymentRow | null> {
  if (!payload.order_id) return null;
  const { rows } = await query<PaymentRow>(
    db,
    sql`SELECT * FROM "Payment" WHERE "clientTxnId" = ${payload.order_id}::text LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** What GuruPay itself says about a payment, asked directly. */
export interface GatewayTruth {
  status: PaymentStatus | null;
  amount: number | null;
  utr: string | null;
  gatewayTxnId: string | null;
}

/**
 * Asks GuruPay what actually happened to a payment.
 *
 * This is the ONLY check that makes a webhook safe to act on — GuruPay sends
 * no signature at all, so the incoming payload proves nothing by itself. See
 * the trust-model note at the top of this module. Every settlement that
 * releases food goes through here first.
 */
export async function fetchGatewayStatus(
  config: PaymentConfig,
  clientTxnId: string,
): Promise<GatewayTruth> {
  const envelope = await callGateway<CheckStatusData>(config, "/check-status", {
    order_id: clientTxnId,
  });
  const data = envelope.data;
  if (!data) return { status: null, amount: null, utr: null, gatewayTxnId: null };

  const amount = Number(data.amount);
  return {
    status: mapGatewayStatus(data.payment_status),
    amount: Number.isFinite(amount) ? amount : null,
    utr: data.utr ?? null,
    gatewayTxnId: data.gateway_txn_id ?? null,
  };
}

/**
 * Applies a webhook, after independently confirming it with GuruPay.
 *
 * Runs in one transaction and takes `FOR UPDATE` on the payment row, because
 * the gateway may deliver the same event twice concurrently: without the lock
 * both copies would read PENDING, both would pass the idempotency check, and
 * both would confirm the orders. The row lock serialises them, and the second
 * one then sees a terminal status and does nothing.
 *
 * `config` is what turns on the check-status confirmation, which is REQUIRED
 * for any outcome that releases food: GuruPay's webhook is unsigned, so the
 * payload alone proves nothing about who sent it or whether it is still
 * true. Omitting `config` (the reconciliation path, which already has the
 * gateway's answer in hand) skips the second call rather than making it twice.
 */
export async function applyWebhook(
  pool: Pool,
  payload: WebhookPayload,
  options: { config?: PaymentConfig; alreadyVerified?: boolean } = {},
): Promise<SettlementResult> {
  const claimed = mapGatewayStatus(payload.status ?? payload.event?.split(".").pop());
  if (!claimed) {
    return {
      changed: false,
      payment: null,
      status: null,
      confirmedOrderIds: [],
      releasedOrderIds: [],
      reason: `unrecognised status "${payload.status ?? payload.event ?? ""}"`,
    };
  }

  /**
   * Ask GuruPay directly, BEFORE opening the transaction.
   *
   * Before, because this is a network call and holding a row lock across one
   * would pin the payment row for as long as the gateway takes to answer —
   * exactly the mistake the two-statement order path was written to avoid.
   *
   * The gateway's answer replaces the payload's claim outright. A webhook that
   * says "success" against a payment GuruPay still calls pending settles
   * nothing, which is precisely the leaked-secret-replay case this exists to
   * stop.
   */
  let incoming = claimed;
  let verified = false;
  let truth: GatewayTruth | null = null;

  if (options.alreadyVerified) {
    verified = true;
  } else if (options.config) {
    const found = await findPaymentForWebhook(pool, payload);
    if (!found) {
      return {
        changed: false,
        payment: null,
        status: null,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "no matching payment",
      };
    }
    try {
      truth = await fetchGatewayStatus(options.config, found.clientTxnId);
      verified = true;
    } catch (err) {
      // Could not reach GuruPay. Deliberately settles NOTHING rather than
      // falling back to the payload: an unverifiable claim is exactly what an
      // attacker would send, and the poll and expiry sweep both still run, so
      // a genuine payment is picked up moments later anyway.
      console.error("[payments] could not verify webhook with the gateway", err);
      return {
        changed: false,
        payment: found,
        status: found.status,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "gateway verification failed",
      };
    }

    if (!truth.status) {
      return {
        changed: false,
        payment: found,
        status: found.status,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "gateway reported no usable status",
      };
    }

    if (truth.status !== claimed) {
      // Worth shouting about: either GuruPay changed its mind between sending
      // the webhook and answering us, or the delivery was replayed from a
      // leaked secret against a payment that has since moved on.
      console.warn(
        "[payments] webhook disagrees with the gateway",
        { claimed, actual: truth.status, paymentId: found.id },
      );
    }
    // The gateway wins, always.
    incoming = truth.status;
  } else {
    // No config and not pre-verified: refuse rather than trusting the payload.
    return {
      changed: false,
      payment: null,
      status: null,
      confirmedOrderIds: [],
      releasedOrderIds: [],
      reason: "no gateway config to verify against",
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10000ms'");
    await client.query("SET LOCAL statement_timeout = '15000ms'");

    const found = await findPaymentForWebhook(client, payload);
    if (!found) {
      await client.query("ROLLBACK");
      return {
        changed: false,
        payment: null,
        status: null,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "no matching payment",
      };
    }

    // Re-read under lock: `found` was read without one, and its status may
    // already be stale by the time we get here.
    const { rows: lockedRows } = await query<PaymentRow>(
      client,
      sql`SELECT * FROM "Payment" WHERE "id" = ${found.id}::text FOR UPDATE`,
    );
    const payment = lockedRows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return {
        changed: false,
        payment: null,
        status: null,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "payment vanished under lock",
      };
    }

    // Replay guard. GuruPay sends no idempotency key of its own, so one is
    // derived from the values that are unique to a settled transaction: the
    // outcome plus the bank's UTR. A retry of the same delivery therefore
    // produces the same key and is answered as the no-op it is.
    // Derived from the gateway's UTR only. A payload-supplied one would let a
    // forged delivery choose the replay key, and so decide whether a later
    // genuine delivery is mistaken for a duplicate and ignored.
    const deliveryKey = truth?.utr ? `${incoming}:${truth.utr}` : null;

    if (deliveryKey && payment.idempotencyKey === deliveryKey) {
      await client.query("ROLLBACK");
      return {
        changed: false,
        payment,
        status: payment.status,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: "duplicate delivery",
      };
    }

    // Terminal states are final. A late 'failed' after a confirmed 'success'
    // must never un-confirm an order the kitchen has already started cooking;
    // a dispute like that is settled by a human against the gateway dashboard,
    // not by silently reversing state here.
    if (payment.status !== "PENDING") {
      await client.query("ROLLBACK");
      return {
        changed: false,
        payment,
        status: payment.status,
        confirmedOrderIds: [],
        releasedOrderIds: [],
        reason: `payment already ${payment.status}`,
      };
    }

    // The money must match what we asked for. A success naming a different
    // amount is not a payment for this order — it is either a gateway fault or
    // a tampered payload, and neither may be allowed to release food.
    // Compared in paise to avoid float equality.
    if (incoming === "SUCCESS") {
      const expectedPaise = Math.round(Number(payment.amount) * 100);
      // The gateway's figure, not the payload's — the payload is a claim.
      const paidPaise = Math.round(Number(truth?.amount ?? payload.amount ?? 0) * 100);
      if (paidPaise !== expectedPaise) {
        await query(
          client,
          sql`
            UPDATE "Payment"
               SET "status" = 'FAILED',
                   "failureReason" = ${`amount mismatch: expected ${payment.amount}, gateway reported ${truth?.amount ?? payload.amount}`}::text,
                   "idempotencyKey" = COALESCE(${deliveryKey}::text, "idempotencyKey"),
                   "webhookCount" = "webhookCount" + 1,
                   "updatedAt" = NOW()
             WHERE "id" = ${payment.id}::text
          `,
        );
        const released = await releaseOrdersForPayment(client, payment.id);
        await client.query("COMMIT");
        console.error("[payments] amount mismatch, payment refused", {
          paymentId: payment.id,
          expected: payment.amount,
          received: truth?.amount ?? payload.amount,
        });
        return {
          changed: true,
          payment,
          status: "FAILED",
          confirmedOrderIds: [],
          releasedOrderIds: released,
          reason: "amount mismatch",
        };
      }
    }

    /**
     * Settlement facts come ONLY from the gateway's own answer, never from the
     * delivery.
     *
     * The payload could in principle be replayed from a leaked secret with a
     * plausible UTR; writing it straight into the payment record would poison
     * the fields a later dispute is read from — even though the order itself
     * was correctly refused. `truth` is always populated by the time this
     * runs; applyWebhook returns earlier otherwise.
     */
    await query(
      client,
      sql`
        UPDATE "Payment"
           SET "status" = ${incoming}::text,
               "upiTxnId" = COALESCE(${truth?.utr ?? null}::text, "upiTxnId"),
               "gatewayOrderId" = COALESCE("gatewayOrderId", ${truth?.gatewayTxnId ?? null}::text),
               "verifiedViaStatusApi" = ${verified}::boolean,
               "paidAt" = ${incoming === "SUCCESS" ? sql`NOW()` : sql`"paidAt"`},
               "failureReason" = ${
                 incoming === "FAILED" || incoming === "EXPIRED"
                   ? sql`COALESCE("failureReason", ${`gateway reported ${incoming.toLowerCase()}`}::text)`
                   : sql`"failureReason"`
               },
               "idempotencyKey" = COALESCE(${deliveryKey}::text, "idempotencyKey"),
               "webhookCount" = "webhookCount" + 1,
               "updatedAt" = NOW()
         WHERE "id" = ${payment.id}::text
      `,
    );

    let confirmedOrderIds: string[] = [];
    let releasedOrderIds: string[] = [];

    if (incoming === "SUCCESS") {
      confirmedOrderIds = await confirmOrdersForPayment(client, payment.id);
    } else if (incoming === "FAILED" || incoming === "EXPIRED") {
      releasedOrderIds = await releaseOrdersForPayment(client, payment.id);
    }
    // PENDING falls through: nothing to do, but the row is refreshed above so
    // a poll sees the gateway acknowledged it.

    await client.query("COMMIT");
    return {
      changed: true,
      payment,
      status: incoming,
      confirmedOrderIds,
      releasedOrderIds,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Makes a payment's orders real to the kitchen.
 *
 * Only clears `awaitingPayment`; status stays PENDING, which is what every
 * existing board query, status transition and notification already understands
 * as a new order. The reservation stays exactly as createOrder made it.
 */
async function confirmOrdersForPayment(db: RawRunner, paymentId: string): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    db,
    sql`
      UPDATE "Order"
         SET "awaitingPayment" = FALSE
       WHERE "paymentId" = ${paymentId}::text
         AND "awaitingPayment" = TRUE
         AND "status" = 'PENDING'
      RETURNING "id"
    `,
  );
  return rows.map((r) => r.id);
}

/**
 * Cancels orders that never got a payment open against them, and hands their
 * stock back.
 *
 * The gap this closes: checkout writes the orders BEFORE calling the gateway,
 * so that stock is held while the student pays. When that call then fails — no
 * merchant connected, gateway down, request refused — the orders are left
 * reserved and invisible, holding food nobody can buy for the full four-hour
 * reservation TTL. The expiry sweep would eventually free them, but "eventually"
 * is hours during which the kitchen is short of stock it could have sold.
 *
 * Scoped to orders with NO paymentId, so it can never touch an order whose
 * payment is genuinely open and awaiting a webhook.
 */
export async function releaseUnpaidOrders(pool: Pool, orderIds: string[]): Promise<string[]> {
  if (orderIds.length === 0) return [];

  // Same two-statement shape, and the same reasons, as
  // releaseOrdersForPayment below — see its comment about RETURNING and
  // unreferenced data-modifying CTEs.
  await query(
    pool,
    sql`
      WITH settled AS (
        UPDATE "Order"
           SET "stockSettledAt" = NOW()
         WHERE "id" = ANY(${orderIds}::text[])
           AND "paymentId" IS NULL
           AND "awaitingPayment" = TRUE
           AND "status" = 'PENDING'
           AND "reservedAt" IS NOT NULL
           AND "stockSettledAt" IS NULL
        RETURNING "id"
      ),
      give_back AS (
        SELECT oi."menuItemId" AS mid, SUM(oi."quantity")::int AS qty
          FROM "OrderItem" oi
          JOIN settled s ON s."id" = oi."orderId"
         GROUP BY oi."menuItemId"
      ),
      moved AS (
        UPDATE "MenuItem" m
           SET "reservedQty" = GREATEST(0, m."reservedQty" - g.qty)
          FROM give_back g
         WHERE m."id" = g.mid
        RETURNING m."id"
      )
      SELECT "id" FROM settled
    `,
  );

  const { rows } = await query<{ id: string }>(
    pool,
    sql`
      UPDATE "Order"
         SET "status" = 'CANCELLED',
             "awaitingPayment" = FALSE
       WHERE "id" = ANY(${orderIds}::text[])
         AND "paymentId" IS NULL
         AND "awaitingPayment" = TRUE
         AND "status" = 'PENDING'
      RETURNING "id"
    `,
  );
  return rows.map((r) => r.id);
}

/**
 * Cancels a payment's orders and hands their stock back.
 *
 * Mirrors releaseOrderReservation() in orderService, and for the same reason:
 * the "was this order still holding stock?" test lives in the WHERE clause,
 * not in RETURNING. Postgres RETURNING yields POST-update values, so a
 * predicate like `stockSettledAt IS NULL` evaluated there is always false —
 * the same statement just stamped it — and the give-back silently moves
 * nothing. That reads as an ordinary cancel while quietly stranding the
 * portions forever.
 *
 * So `settled` stamps only rows that genuinely still held a reservation, and
 * the decrement joins off its RETURNING. A second delivery, or a webhook
 * racing the expiry sweep, updates zero rows there and therefore moves no
 * stock — the release is idempotent by construction.
 *
 * Two statements rather than one, and deliberately so. A data-modifying CTE
 * only runs if the main query can reach it, so folding the cancel in beside
 * the give-back and then selecting from the cancel would leave the stock
 * update unreferenced — and therefore never executed, silently. Both callers
 * are already inside applyWebhook's transaction, so the pair is atomic anyway
 * and there is nothing to gain by squeezing them into one statement.
 *
 * Order matters: the give-back reads rows that are still `awaitingPayment`, so
 * it has to run before the cancel clears that flag.
 */
async function releaseOrdersForPayment(db: RawRunner, paymentId: string): Promise<string[]> {
  // Statement 1 — hand the portions back, for the orders still holding them.
  // The final SELECT reads `settled`, which `moved` feeds from, so the stock
  // update is reachable and actually runs.
  await query<{ id: string }>(
    db,
    sql`
      WITH settled AS (
        UPDATE "Order"
           SET "stockSettledAt" = NOW()
         WHERE "paymentId" = ${paymentId}::text
           AND "awaitingPayment" = TRUE
           AND "status" = 'PENDING'
           AND "reservedAt" IS NOT NULL
           AND "stockSettledAt" IS NULL
        RETURNING "id"
      ),
      give_back AS (
        SELECT oi."menuItemId" AS mid, SUM(oi."quantity")::int AS qty
          FROM "OrderItem" oi
          JOIN settled s ON s."id" = oi."orderId"
         GROUP BY oi."menuItemId"
      ),
      moved AS (
        UPDATE "MenuItem" m
           SET "reservedQty" = GREATEST(0, m."reservedQty" - g.qty)
          FROM give_back g
         WHERE m."id" = g.mid
        RETURNING m."id"
      )
      SELECT "id" FROM settled
    `,
  );

  // Statement 2 — cancel every unpaid order on this payment, including any
  // whose reservation the expiry sweep had already released above.
  const { rows } = await query<{ id: string }>(
    db,
    sql`
      UPDATE "Order"
         SET "status" = 'CANCELLED',
             "awaitingPayment" = FALSE
       WHERE "paymentId" = ${paymentId}::text
         AND "awaitingPayment" = TRUE
         AND "status" = 'PENDING'
      RETURNING "id"
    `,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Status reads and expiry
// ---------------------------------------------------------------------------

/**
 * A payment as its owner may see it.
 *
 * Owner-scoped in the query itself rather than fetched-then-checked: a payment
 * belonging to someone else returns nothing at all, so there is no path where
 * a forgotten check leaks one student's transaction to another.
 */
export async function getPaymentForOwner(
  pool: Pool,
  paymentId: string,
  owner: { studentId?: string; guestSessionId?: string },
): Promise<PaymentRow | null> {
  const ownerPredicate = owner.studentId
    ? sql`"studentId" = ${owner.studentId}::text`
    : sql`"guestSessionId" = ${owner.guestSessionId ?? ""}::text`;

  const { rows } = await query<PaymentRow>(
    pool,
    sql`SELECT * FROM "Payment" WHERE "id" = ${paymentId}::text AND ${ownerPredicate} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Asks the gateway what really happened.
 *
 * The webhook is the primary path; this is the fallback for when it never
 * arrives — a dropped delivery, or our worker being unreachable at the moment
 * the gateway tried. Called from the status poll while a payment is still
 * PENDING, so a student who has actually paid is not left staring at a spinner
 * because one HTTP request went missing.
 */
export async function reconcileWithGateway(
  pool: Pool,
  bindings: Bindings,
  payment: PaymentRow,
): Promise<SettlementResult | null> {
  if (payment.status !== "PENDING") return null;
  const config = getPaymentConfig(bindings);

  const truth = await fetchGatewayStatus(config, payment.clientTxnId);
  if (!truth.status || truth.status === "PENDING") return null;

  // Reuses the webhook path so a reconciled settlement takes exactly the same
  // locking, amount check and idempotency route as a delivered one. There is
  // no second, subtly different settlement implementation to keep in step.
  //
  // `alreadyVerified` because this answer came straight from check-status —
  // it IS the verification, so asking again would be the same call twice.
  return applyWebhook(
    pool,
    {
      event: truth.status.toLowerCase(),
      status: truth.status.toLowerCase(),
      order_id: payment.clientTxnId,
      amount: truth.amount ?? undefined,
      utr: truth.utr,
    },
    { alreadyVerified: true },
  );
}

/**
 * Closes out payments whose window has passed with nothing decided, and gives
 * their orders' stock back.
 *
 * Hung off reads the same way sweepReservations is, because Workers has no
 * always-on process to run a scheduled job in. The partial index on
 * (expiresAt) WHERE status = 'PENDING' keeps this off the settled majority of
 * the table.
 */
export async function expireStalePayments(pool: Pool): Promise<number> {
  try {
    const { rows } = await query<{ id: string }>(
      pool,
      sql`
        UPDATE "Payment"
           SET "status" = 'EXPIRED',
               "failureReason" = COALESCE("failureReason", 'payment window elapsed'),
               "updatedAt" = NOW()
         WHERE "status" = 'PENDING'
           AND "expiresAt" IS NOT NULL
           AND "expiresAt" < NOW()
        RETURNING "id"
      `,
    );
    for (const row of rows) {
      await releaseOrdersForPayment(pool, row.id);
    }
    return rows.length;
  } catch (err) {
    // Housekeeping must never fail the read it is hanging off.
    console.warn("[payments] expiry sweep failed", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Webhook forensics
// ---------------------------------------------------------------------------

/**
 * Records a delivery exactly as it arrived.
 *
 * This is evidence, not application state: nothing reads it to make a
 * decision. It exists so that "the student says they paid but the order never
 * confirmed" is an answerable question — did GuruPay send a success we
 * mishandled, or did they never send one? Without the raw body that is pure
 * speculation, because the request is gone once it returns.
 *
 * Best-effort by construction. A webhook must still be processed and 200-ed
 * even if this write fails; losing the audit trail is far better than making
 * the gateway retry a settlement that already happened.
 */
export async function recordWebhook(
  db: RawRunner,
  payload: unknown,
  authenticated: boolean,
  outcome: string | null,
): Promise<void> {
  try {
    const body = (payload ?? {}) as Record<string, any>;

    await query(
      db,
      sql`
        INSERT INTO "WebhookLog" ("id","event","status","merchantOrderId","systemOrderId","payload","authenticated","outcome")
        VALUES (
          ${crypto.randomUUID()}::text,
          ${typeof body.event === "string" ? body.event : null}::text,
          ${typeof body.status === "string" ? body.status : null}::text,
          ${typeof body.order_id === "string" ? body.order_id : null}::text,
          ${null}::text,
          ${JSON.stringify(body)}::jsonb,
          ${authenticated}::boolean,
          ${outcome}::text
        )
      `,
    );
  } catch (err) {
    console.error("[payments] failed to record webhook", err);
  }
}

/** Stamps what we decided onto the row just written for this delivery. */
export async function recordWebhookOutcome(
  db: RawRunner,
  payload: unknown,
  outcome: string | null,
): Promise<void> {
  try {
    const body = (payload ?? {}) as Record<string, any>;
    const ref = typeof body.order_id === "string" ? body.order_id : null;
    if (!ref) return;
    await query(
      db,
      sql`
        UPDATE "WebhookLog"
           SET "outcome" = ${outcome}::text
         WHERE "id" = (
           SELECT "id" FROM "WebhookLog"
            WHERE "merchantOrderId" = ${ref}::text AND "outcome" IS NULL
            ORDER BY "receivedAt" DESC LIMIT 1
         )
      `,
    );
  } catch (err) {
    console.error("[payments] failed to record webhook outcome", err);
  }
}
