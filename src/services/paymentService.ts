import type { Pool, PoolClient } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import { sql, query } from "../db/sql.js";
import type { Bindings } from "../types.js";

/** Anything that can run a query — a Pool, or a PoolClient inside a
 *  transaction. Mirrors the same alias in orderService.ts. */
type RawRunner = Pick<Pool | PoolClient, "query">;

/**
 * UPI payments through VyaparGateway.
 *
 * Callers: routes/payments.ts (checkout, status poll, webhook).
 * Shape: one Payment covers a whole cart, which createOrder may have split
 * into one Order per kitchen — so the FK sits on Order and a settlement fans
 * out to every order carrying this paymentId.
 *
 * Nothing here trusts the client for money. The amount charged is recomputed
 * from the orders we wrote; the amount confirmed is checked against it again
 * when the webhook lands.
 */

const GATEWAY_BASE_URL = "https://vyapargateway.com";

/** Gateway's own window is 2 minutes. Ours matches, tracked independently so
 *  an expired payment is closed out even if no webhook ever arrives. */
export const PAYMENT_WINDOW_MS = 2 * 60 * 1000;

/** Rupee bounds the gateway documents. Rejected here so a doomed order is
 *  never written, rather than discovered by a 400 from create_order. */
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
  qrCode: string | null;
  upiString: string | null;
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
  apiKey: string;
  webhookSecret: string;
  callbackUrl: string;
  redirectUrl?: string;
}

/**
 * True only when payments are switched on AND fully configured.
 *
 * Deliberately two conditions: a half-configured deploy (flag on, secret
 * missing) must not present a checkout that cannot settle. It reads as "off"
 * instead, which is the safe direction — ordering still works.
 */
export function paymentsEnabled(bindings: Bindings): boolean {
  if (String(bindings.PAYMENTS_ENABLED ?? "").toLowerCase() !== "true") return false;
  return Boolean(bindings.VYAPAR_API_KEY && bindings.VYAPAR_WEBHOOK_SECRET);
}

/**
 * Config or a hard failure. Called only behind paymentsEnabled(), so a throw
 * here means the flag was flipped on without the secrets — worth a 503 that
 * names the cause rather than a confusing gateway error later.
 */
export function getPaymentConfig(bindings: Bindings): PaymentConfig {
  const apiKey = bindings.VYAPAR_API_KEY;
  const webhookSecret = bindings.VYAPAR_WEBHOOK_SECRET;
  const callbackUrl = bindings.VYAPAR_CALLBACK_URL;

  if (!apiKey || !webhookSecret || !callbackUrl) {
    throw new ApiError(
      503,
      "PAYMENTS_UNCONFIGURED",
      "Payments are not configured. Set VYAPAR_API_KEY, VYAPAR_WEBHOOK_SECRET and VYAPAR_CALLBACK_URL.",
    );
  }
  return {
    apiKey,
    webhookSecret,
    callbackUrl,
    redirectUrl: bindings.VYAPAR_REDIRECT_URL,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Constant-time compare of two hex strings.
 *
 * Node's crypto.timingSafeEqual is not available on workerd, so the compare is
 * written out: fixed-length accumulate, no early return. The length check is
 * folded into the result rather than short-circuiting, so a wrong-length
 * signature costs the same as a wrong-value one.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const equalLength = a.length === b.length;
  // Compare against itself on mismatch so loop cost never depends on b.
  const rhs = equalLength ? b : a;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ rhs.charCodeAt(i);
  }
  return diff === 0 && equalLength;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * HMAC-SHA256 over `{timestamp}.{rawBody}`, per the gateway's documented
 * scheme.
 *
 * `rawBody` must be the exact bytes received. The dashboard's Python and Node
 * samples re-serialize the parsed JSON before signing, which yields a
 * different string than the one that was signed — key order, separators,
 * unicode escaping and float formatting all differ between serializers. The
 * API documentation says to sign the raw body, and that is what happens here.
 */
export async function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return toHex(signature);
}

/** How far out of step a webhook timestamp may be before it is refused. Bounds
 *  the window in which a captured delivery can still be replayed. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies a webhook's signature and freshness.
 *
 * Freshness is checked as well as the signature because a signature stays
 * valid forever: with no timestamp bound, anyone who ever captured one genuine
 * delivery could replay it indefinitely. Both directions are bounded — a
 * far-future timestamp is as suspect as an old one.
 */
export async function verifyWebhook(
  secret: string,
  headers: { signature?: string; timestamp?: string },
  rawBody: string,
  now: Date = new Date(),
): Promise<WebhookVerification> {
  const { signature, timestamp } = headers;
  if (!signature) return { ok: false, reason: "missing signature header" };
  if (!timestamp) return { ok: false, reason: "missing timestamp header" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed timestamp header" };

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (skew > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp outside tolerance (${skew}s)` };
  }

  const expected = await computeWebhookSignature(secret, timestamp, rawBody);
  if (!timingSafeEqualHex(signature.trim().toLowerCase(), expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

interface GatewayEnvelope<T> {
  status: boolean;
  msg: string;
  data: T;
  /**
   * The gateway's OTHER error shape.
   *
   * Success and business-rule failures come back in the documented
   * `{status, msg, data}` envelope, but errors raised before that layer —
   * an unrecognised key, an IP that is not whitelisted, no merchant connected
   * — arrive as a bare `{"detail": "..."}` instead. Reading only `msg` there
   * loses the one sentence that says what is actually wrong, which is how
   * "No provider is enabled for this tenant" reached the logs as `undefined`.
   */
  detail?: string;
}

/** Whichever field this response carries its reason in. */
function gatewayMessage<T>(parsed: GatewayEnvelope<T>): string | undefined {
  return parsed.msg || parsed.detail || undefined;
}

interface CreateOrderData {
  order_id: string;
  client_txn_id: string;
  amount: number;
  currency: string;
  status: string;
  expires_at: string;
  qr_code: string;
  upi_string: string;
  upi_intent?: Record<string, string>;
  merchant_upi_id?: string;
  merchant_name?: string;
}

interface CheckStatusData {
  order_id: string;
  client_txn_id: string;
  amount: number;
  currency: string;
  status: string;
  upi_txn_id?: string;
  expires_at?: string;
}

/** Gateway calls are capped well under the 2-minute payment window: a hung
 *  connection must not hold a request open until the order it is paying for
 *  has already expired. */
const GATEWAY_TIMEOUT_MS = 15_000;

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
        // Header auth, so the key never rides in a body that might be logged.
        "X-API-Key": config.apiKey,
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

  if (!response.ok || !parsed.status) {
    // The gateway's own message describes the request we made, not its
    // internals, so it is safe to surface. The key never appears in it.
    const reason = gatewayMessage(parsed);
    console.error("[payments] gateway rejected request", path, response.status, reason ?? "(no reason given)");

    // 412 means the account itself is not ready to take payments — no merchant
    // connected, in practice. That is a configuration problem an operator has
    // to fix in the VyaparGateway dashboard, and it will not resolve on a
    // retry, so it is worth its own code rather than being folded into the
    // generic upstream failure.
    if (response.status === 412) {
      throw new ApiError(
        503,
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        reason ?? "Online payment is not available: no payment provider is connected.",
      );
    }

    const status = response.status === 429 ? 429 : 502;
    throw new ApiError(
      status,
      "PAYMENT_GATEWAY_REJECTED",
      reason ?? "The payment gateway rejected the request.",
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
 * so a retry after a failed create_order gets a fresh reference — the gateway
 * treats client_txn_id as unique and would reject the reuse.
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
  customerEmail?: string;
}

export interface InitiatedPayment {
  paymentId: string;
  clientTxnId: string;
  gatewayOrderId: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  expiresAt: Date;
  qrCode: string;
  upiString: string;
  upiIntent: Record<string, string>;
  merchantUpiId: string | null;
  merchantName: string | null;
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

  // Recorded BEFORE the gateway is called. If create_order succeeds but its
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
    const envelope = await callGateway<CreateOrderData>(config, "/api/v1/create_order", {
      client_txn_id: clientTxnId,
      amount,
      p_info: input.productInfo ?? "Canteen order",
      customer_name: owner.customerName || "Customer",
      ...(owner.customerMobile ? { customer_mobile: owner.customerMobile } : {}),
      ...(owner.customerEmail ? { customer_email: owner.customerEmail } : {}),
      callback_url: config.callbackUrl,
      ...(config.redirectUrl ? { redirect_url: config.redirectUrl } : {}),
      // udf1 carries our payment id back on the webhook, which lets a delivery
      // be matched even if every other reference is somehow absent. The API
      // caps udf fields at 25 characters and a UUID is 36, so the dashes go
      // and the leading 24 hex characters are kept — unique enough to
      // disambiguate, and only ever consulted after clientTxnId and
      // gatewayOrderId have both failed to match.
      udf1: paymentId.replace(/-/g, "").slice(0, 24),
    });
    data = envelope.data;
  } catch (err) {
    // The gateway never opened. Close the row out so the sweep is not left
    // sitting on a payment that can never settle, and the student can retry.
    await query(
      pool,
      sql`
        UPDATE "Payment"
           SET "status" = 'FAILED',
               "failureReason" = 'gateway create_order failed',
               "updatedAt" = NOW()
         WHERE "id" = ${paymentId}::text
      `,
    ).catch((updateErr) => console.error("[payments] failed to close out unopened payment", updateErr));
    throw err;
  }

  // The gateway's expiry wins if it sent one — it is the clock that actually
  // governs whether a scan will still be accepted.
  const gatewayExpiry = data.expires_at ? new Date(data.expires_at) : null;
  const effectiveExpiry =
    gatewayExpiry && !Number.isNaN(gatewayExpiry.getTime()) ? gatewayExpiry : expiresAt;

  await query(
    pool,
    sql`
      UPDATE "Payment"
         SET "gatewayOrderId" = ${data.order_id}::text,
             "qrCode" = ${data.qr_code ?? null}::text,
             "upiString" = ${data.upi_string ?? null}::text,
             "expiresAt" = ${effectiveExpiry.toISOString()}::timestamp,
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
    gatewayOrderId: data.order_id,
    amount: amount.toFixed(2),
    currency: data.currency || "INR",
    status: "PENDING",
    expiresAt: effectiveExpiry,
    qrCode: data.qr_code,
    upiString: data.upi_string,
    upiIntent: data.upi_intent ?? {},
    merchantUpiId: data.merchant_upi_id ?? null,
    merchantName: data.merchant_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** Everything the webhook payload tells us that we act on. Both QR shapes
 *  (static and dynamic) are covered — they carry different reference fields,
 *  so every identifier is optional and matching tries them in turn. */
export interface WebhookPayload {
  event?: string;
  status?: string;
  order_id?: string;
  client_txn_id?: string;
  amount?: number | string;
  currency?: string;
  upi_txn_id?: string;
  payer_vpa?: string;
  payer_name?: string;
  idempotency_key?: string;
  udf1?: string;
  timestamp?: number | string;
}

/** Gateway vocabulary to ours. 'processing' folds into PENDING because it
 *  carries no decision — the money has neither arrived nor been refused. */
function mapGatewayStatus(raw: string | undefined): PaymentStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "success":
      return "SUCCESS";
    case "failed":
      return "FAILED";
    case "expired":
      return "EXPIRED";
    case "pending":
    case "processing":
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
 * Three references are tried in descending order of trustworthiness:
 * client_txn_id is ours and unique by construction; order_id is the gateway's
 * and unique once we have stored it; udf1 is the truncated payment id, a last
 * resort for a delivery that somehow carries neither.
 */
async function findPaymentForWebhook(
  db: RawRunner,
  payload: WebhookPayload,
): Promise<PaymentRow | null> {
  if (payload.client_txn_id) {
    const { rows } = await query<PaymentRow>(
      db,
      sql`SELECT * FROM "Payment" WHERE "clientTxnId" = ${payload.client_txn_id}::text LIMIT 1`,
    );
    if (rows[0]) return rows[0];
  }
  if (payload.order_id) {
    const { rows } = await query<PaymentRow>(
      db,
      sql`SELECT * FROM "Payment" WHERE "gatewayOrderId" = ${payload.order_id}::text LIMIT 1`,
    );
    if (rows[0]) return rows[0];
  }
  if (payload.udf1) {
    // udf1 is the payment UUID with dashes stripped, truncated to 24 chars.
    // Matched by prefix against the same transformation of the stored id.
    const { rows } = await query<PaymentRow>(
      db,
      sql`
        SELECT * FROM "Payment"
         WHERE LEFT(REPLACE("id", '-', ''), 24) = ${payload.udf1}::text
         LIMIT 1
      `,
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Applies a verified webhook.
 *
 * Runs in one transaction and takes `FOR UPDATE` on the payment row, because
 * the gateway may deliver the same event twice concurrently: without the lock
 * both copies would read PENDING, both would pass the idempotency check, and
 * both would confirm the orders. The row lock serialises them, and the second
 * one then sees a terminal status and does nothing.
 *
 * The signature must already have been checked by the caller — this function
 * assumes the payload is genuine and acts on it.
 */
export async function applyWebhook(
  pool: Pool,
  payload: WebhookPayload,
): Promise<SettlementResult> {
  const incoming = mapGatewayStatus(payload.status ?? payload.event?.split(".")[1]);
  if (!incoming) {
    return {
      changed: false,
      payment: null,
      status: null,
      confirmedOrderIds: [],
      releasedOrderIds: [],
      reason: `unrecognised status "${payload.status ?? payload.event ?? ""}"`,
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

    // Replay guard. The gateway retries until it is 200-ed, so the same key
    // arriving twice is expected traffic, not an attack — answered as a no-op.
    if (payload.idempotency_key && payment.idempotencyKey === payload.idempotency_key) {
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
    // a tampered payload that cleared signature checking, and neither may be
    // allowed to release food. Compared in paise to avoid float equality.
    if (incoming === "SUCCESS") {
      const expectedPaise = Math.round(Number(payment.amount) * 100);
      const paidPaise = Math.round(Number(payload.amount ?? 0) * 100);
      if (paidPaise !== expectedPaise) {
        await query(
          client,
          sql`
            UPDATE "Payment"
               SET "status" = 'FAILED',
                   "failureReason" = ${`amount mismatch: expected ${payment.amount}, received ${payload.amount}`}::text,
                   "idempotencyKey" = COALESCE(${payload.idempotency_key ?? null}::text, "idempotencyKey"),
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
          received: payload.amount,
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

    await query(
      client,
      sql`
        UPDATE "Payment"
           SET "status" = ${incoming}::text,
               "upiTxnId" = COALESCE(${payload.upi_txn_id ?? null}::text, "upiTxnId"),
               "payerVpa" = COALESCE(${payload.payer_vpa ?? null}::text, "payerVpa"),
               "payerName" = COALESCE(${payload.payer_name ?? null}::text, "payerName"),
               "paidAt" = ${incoming === "SUCCESS" ? sql`NOW()` : sql`"paidAt"`},
               "failureReason" = ${
                 incoming === "FAILED" || incoming === "EXPIRED"
                   ? sql`COALESCE("failureReason", ${`gateway reported ${incoming.toLowerCase()}`}::text)`
                   : sql`"failureReason"`
               },
               "idempotencyKey" = COALESCE(${payload.idempotency_key ?? null}::text, "idempotencyKey"),
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

  const envelope = await callGateway<CheckStatusData>(config, "/api/v1/check_order_status", {
    ...(payment.gatewayOrderId
      ? { order_id: payment.gatewayOrderId }
      : { client_txn_id: payment.clientTxnId }),
  });

  const data = envelope.data;
  const mapped = mapGatewayStatus(data.status);
  if (!mapped || mapped === "PENDING") return null;

  // Reuses the webhook path so a reconciled settlement takes exactly the same
  // locking, amount check and idempotency route as a delivered one. There is
  // no second, subtly different settlement implementation to keep in step.
  return applyWebhook(pool, {
    status: data.status,
    client_txn_id: payment.clientTxnId,
    order_id: data.order_id ?? payment.gatewayOrderId ?? undefined,
    amount: data.amount,
    upi_txn_id: data.upi_txn_id,
    // No idempotency key from this endpoint; the FOR UPDATE terminal-status
    // check is what stops a poll racing a webhook to double-settle.
  });
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
