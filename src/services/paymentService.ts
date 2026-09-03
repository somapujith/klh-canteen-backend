import type { Pool, PoolClient } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import { sql, query } from "../db/sql.js";
import type { Bindings } from "../types.js";

/** Anything that can run a query — a Pool, or a PoolClient inside a
 *  transaction. Mirrors the same alias in orderService.ts. */
type RawRunner = Pick<Pool | PoolClient, "query">;

/**
 * UPI payments through SafeUPI.
 *
 * Callers: routes/payments.ts (checkout, status poll, webhook).
 * Shape: one Payment covers a whole cart, which createOrder may have split
 * into one Order per kitchen — so the FK sits on Order and a settlement fans
 * out to every order carrying this paymentId.
 *
 * Nothing here trusts the client for money. The amount charged is recomputed
 * from the orders we wrote, and the amount SafeUPI reports is checked against
 * it again before a single order is released.
 *
 * THE TRUST MODEL IS WEAKER THAN IT LOOKS, and the code is shaped around that.
 * SafeUPI's webhook is not signed: it echoes a shared secret back in the
 * request body. Anything that ever sees one delivery — a log, a proxy, a
 * misconfigured egress — learns the secret and can then forge a "success".
 * So a webhook is treated as a HINT THAT SOMETHING HAPPENED, never as proof
 * that it did: every settlement is independently confirmed by calling
 * SafeUPI's own Status API before any food is released. Forging a delivery
 * therefore is not enough; an attacker would also have to fool SafeUPI.
 */

const GATEWAY_BASE_URL = "https://www.safeupi.com";

/**
 * How long a payment is held open before it is closed out as expired.
 *
 * SafeUPI does not document a checkout expiry for the hosted page the way the
 * previous gateway did, so this is our own bound rather than a mirror of
 * theirs. Fifteen minutes is chosen to be comfortably longer than a student
 * fumbling with a UPI PIN, while still returning the food to the counter the
 * same lunch hour if they wander off.
 */
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

/** Rupee bounds. SafeUPI documents only "a positive number", so these are our
 *  own sanity rails: a zero-rupee order is a bug, and a five-figure canteen
 *  bill is far more likely to be one than a real lunch. */
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
  /** SafeUPI's hosted checkout page — where the student is sent to pay. */
  paymentUrl: string | null;
  /** The connected merchant SafeUPI routed this payment to, after fallback. */
  linkedMerchantId: string | null;
  /** sha256 of that merchant's UPI ID, as SafeUPI returns it. */
  merchantUpiHash: string | null;
  /**
   * Whether this payment's outcome was confirmed against SafeUPI's Status API
   * rather than believed from the webhook alone. Recorded because the webhook
   * is unsigned, so "we checked" is a fact worth being able to audit.
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
  /** SafeUPI's `secret` — the API key sent in every request body. */
  apiSecret: string;
  /** The value SafeUPI echoes in a webhook body. Not a signing key. */
  webhookSecret: string;
  /** Where SafeUPI returns the student's browser after the hosted page. */
  redirectUrl: string;
  /** Optional merchant to route to; SafeUPI picks a default when absent. */
  merchantId?: string;
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
  return Boolean(bindings.SAFEUPI_API_SECRET && bindings.SAFEUPI_REDIRECT_URL);
}

/**
 * Config or a hard failure. Called only behind paymentsEnabled(), so a throw
 * here means the flag was flipped on without the secrets — worth a 503 that
 * names the cause rather than a confusing gateway error later.
 *
 * SAFEUPI_WEBHOOK_SECRET is required too, and deliberately so. It is the only
 * thing standing between a stranger's POST and a confirmed order, and an empty
 * expected secret would compare equal to an empty supplied one — turning the
 * check into a no-op precisely when it matters most.
 */
export function getPaymentConfig(bindings: Bindings): PaymentConfig {
  const apiSecret = bindings.SAFEUPI_API_SECRET;
  const webhookSecret = bindings.SAFEUPI_WEBHOOK_SECRET;
  const redirectUrl = bindings.SAFEUPI_REDIRECT_URL;

  if (!apiSecret || !webhookSecret || !redirectUrl) {
    throw new ApiError(
      503,
      "PAYMENTS_UNCONFIGURED",
      "Payments are not configured. Set SAFEUPI_API_SECRET, SAFEUPI_WEBHOOK_SECRET and SAFEUPI_REDIRECT_URL.",
    );
  }
  return {
    apiSecret,
    webhookSecret,
    redirectUrl,
    merchantId: bindings.SAFEUPI_MERCHANT_ID,
  };
}

// ---------------------------------------------------------------------------
// Webhook authentication
// ---------------------------------------------------------------------------

/**
 * Constant-time compare of two strings.
 *
 * Node's crypto.timingSafeEqual is not available on workerd, so the compare is
 * written out: fixed-length accumulate, no early return. The length check is
 * folded into the result rather than short-circuiting, so a wrong-length
 * secret costs the same as a wrong-value one.
 *
 * This matters more here than it did under the previous gateway. SafeUPI's
 * webhook carries the shared secret itself rather than a signature over the
 * payload, so a naive `===` would leak that secret's prefix through response
 * timing — one character at a time, to anyone who can POST repeatedly.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const equalLength = a.length === b.length;
  // Compare against itself on mismatch so loop cost never depends on b.
  const rhs = equalLength ? b : a;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ rhs.charCodeAt(i);
  }
  return diff === 0 && equalLength;
}

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Authenticates a SafeUPI webhook.
 *
 * SafeUPI does not sign its webhooks. It puts a shared secret in the request
 * body and expects the receiver to compare it, so this is a bearer check
 * rather than a proof of integrity: it establishes that the sender knows the
 * secret, and NOTHING about whether the payload was tampered with in flight or
 * even relates to a real payment.
 *
 * That is why this function is not the last word. applyWebhook re-checks the
 * outcome against SafeUPI's Status API before releasing anything, so passing
 * this check buys a caller the right to be listened to, not the right to be
 * believed. See the note at the top of this module.
 *
 * An absent configured secret is refused rather than treated as "no check
 * required" — otherwise a misconfigured deploy would accept every POST.
 */
export function verifyWebhook(
  configuredSecret: string,
  suppliedSecret: unknown,
): WebhookVerification {
  if (!configuredSecret) return { ok: false, reason: "no webhook secret configured" };
  if (typeof suppliedSecret !== "string" || suppliedSecret.length === 0) {
    return { ok: false, reason: "missing secret in payload" };
  }
  if (!timingSafeEqual(suppliedSecret, configuredSecret)) {
    return { ok: false, reason: "secret mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

/**
 * SafeUPI's response envelope: `{ success, message, data }`, with `key` added
 * on some errors as a machine-readable reason (e.g. "duplicate_order_id").
 */
interface GatewayEnvelope<T> {
  success: boolean;
  message?: string;
  key?: string;
  data?: T;
}

/** The human-readable reason, whichever field carries it. */
function gatewayMessage<T>(parsed: GatewayEnvelope<T>): string | undefined {
  return parsed.message || parsed.key || undefined;
}

/** POST /api/order/create */
interface CreateOrderData {
  id: number;
  system_order_id: string;
  merchant_order_id: string;
  linked_merchant_id?: number | string | null;
  merchant_upi_id?: string;
  merchant_type?: string;
  payment?: {
    url?: string;
    checkout?: { token?: string; sdk_url?: string; expires_at?: string };
    paylinks?: Record<string, Record<string, { icon?: string; link?: string }>>;
    /** Only returned for selected businesses, so never relied on. */
    qr_code?: string;
  };
}

/** POST /api/order/status */
interface CheckStatusData {
  id: number;
  system_order_id: string;
  merchant_order_id: string;
  status: string;
  amount: string | number;
  merchant_info?: { name?: string; upi_id?: string };
  created_at?: number;
  payment?: {
    transaction_at?: number | string | null;
    utr?: string | null;
    customer_vpa?: string | null;
  };
}

/** Capped well under the payment window: a hung connection must not hold a
 *  request open until the order it is paying for has already expired. */
const GATEWAY_TIMEOUT_MS = 15_000;

/**
 * One SafeUPI call.
 *
 * The API key rides in the JSON body as `secret`, which is SafeUPI's documented
 * scheme and not a choice available to us — there is no header form. It is a
 * meaningfully worse place for a credential than a header (bodies are what get
 * logged and echoed back in error reports), so nothing in this module ever logs
 * a request body, and the error paths below log only the response.
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ secret: config.apiSecret, ...body }),
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

  // SafeUPI signals failure with `success: false` and may still answer HTTP
  // 200, so the envelope is authoritative rather than the status code.
  if (!response.ok || !parsed.success) {
    const reason = gatewayMessage(parsed);
    console.error("[payments] gateway rejected request", path, response.status, reason ?? "(no reason given)");

    // A reused merchant_order_id is our bug, not the student's, and retrying
    // the same id will never succeed — worth its own code so it is greppable
    // rather than buried in the generic upstream failure.
    if (parsed.key === "duplicate_order_id") {
      throw new ApiError(
        500,
        "PAYMENT_DUPLICATE_ORDER_ID",
        "Could not start the payment. Please try again.",
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
  /**
   * SafeUPI's hosted checkout page. The client sends the student here; this is
   * the whole of the payment UI under the hosted-page flow.
   */
  paymentUrl: string;
  /**
   * Returned only for selected businesses, so it is very often absent and the
   * client must not depend on it. Passed through when present purely so a
   * desktop user can be shown a code instead of being sent to a phone-shaped
   * page, but the hosted page renders its own QR regardless.
   */
  qrCode: string | null;
  linkedMerchantId: string | null;
  merchantUpiHash: string | null;
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
    const envelope = await callGateway<CreateOrderData>(config, "/api/order/create", {
      merchant_order_id: clientTxnId,
      amount: amount.toFixed(2),
      customer_name: owner.customerName || "Customer",
      // Required by SafeUPI even when we do not hold one. A guest ordering at
      // the counter has neither, so a per-payment placeholder on our own domain
      // stands in: it is syntactically valid, unmistakably not a real inbox,
      // and unique so it can never collide with a real student's address.
      customer_email: owner.customerEmail || `${clientTxnId.toLowerCase()}@guest.klh-canteen.invalid`,
      customer_phone: owner.customerMobile || "0000000000",
      // Where SafeUPI returns the browser once the hosted page is done. The
      // payment id rides along so the landing page knows which payment to
      // confirm — it is an opaque lookup key, not a credential: the status
      // endpoint it feeds is owner-scoped and hands nothing to a stranger.
      redirect_url: `${config.redirectUrl}${config.redirectUrl.includes("?") ? "&" : "?"}payment=${paymentId}`,
      ...(config.merchantId ? { merchant_id: config.merchantId } : {}),
      metadata: { payment_id: paymentId, orders: orderIds.join(",") },
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
               "failureReason" = 'gateway order/create failed',
               "updatedAt" = NOW()
         WHERE "id" = ${paymentId}::text
      `,
    ).catch((updateErr) => console.error("[payments] failed to close out unopened payment", updateErr));
    throw err;
  }

  const paymentUrl = data.payment?.url;
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

  const linkedMerchantId =
    data.linked_merchant_id === null || data.linked_merchant_id === undefined
      ? null
      : String(data.linked_merchant_id);

  // SafeUPI documents no expiry for the hosted page, so our own window stands
  // as written at insert time — there is no gateway clock to defer to here.
  await query(
    pool,
    sql`
      UPDATE "Payment"
         SET "gatewayOrderId" = ${data.system_order_id}::text,
             "paymentUrl" = ${paymentUrl}::text,
             "qrCode" = ${data.payment?.qr_code ?? null}::text,
             "linkedMerchantId" = ${linkedMerchantId}::text,
             "merchantUpiHash" = ${data.merchant_upi_id ?? null}::text,
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
    gatewayOrderId: data.system_order_id,
    amount: amount.toFixed(2),
    currency: "INR",
    status: "PENDING",
    expiresAt,
    paymentUrl,
    qrCode: data.payment?.qr_code ?? null,
    linkedMerchantId,
    merchantUpiHash: data.merchant_upi_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** Everything the webhook payload tells us that we act on. Both QR shapes
 *  (static and dynamic) are covered — they carry different reference fields,
 *  so every identifier is optional and matching tries them in turn. */
export interface WebhookPayload {
  /** created | scanning | success | failed | cancelled */
  event?: string;
  data?: {
    id?: number;
    status?: string;
    amount?: number | string;
    merchant_order_id?: string;
    system_order_id?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    metadata?: Record<string, unknown> | null;
    payment?: {
      transaction_at?: string | number | null;
      utr?: string | null;
      customer_vpa?: string | null;
    };
  };
  /** The shared secret SafeUPI echoes back. Checked, never stored or logged. */
  secret?: string;
}

/** Gateway vocabulary to ours. 'processing' folds into PENDING because it
 *  carries no decision — the money has neither arrived nor been refused. */
function mapGatewayStatus(raw: string | undefined): PaymentStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "success":
      return "SUCCESS";
    case "failed":
      return "FAILED";
    case "cancelled":
    case "canceled":
      // The student walked away. Terminal for us in exactly the way a failure
      // is: the order is released and the food goes back on sale.
      return "FAILED";
    case "expired":
      return "EXPIRED";
    // "created" and "scanning" are progress notifications, not decisions —
    // the money has neither arrived nor been refused — so both fold into
    // PENDING and change nothing but the row's updatedAt.
    case "created":
    case "scanning":
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
  const data = payload.data ?? {};

  if (data.merchant_order_id) {
    const { rows } = await query<PaymentRow>(
      db,
      sql`SELECT * FROM "Payment" WHERE "clientTxnId" = ${data.merchant_order_id}::text LIMIT 1`,
    );
    if (rows[0]) return rows[0];
  }
  if (data.system_order_id) {
    const { rows } = await query<PaymentRow>(
      db,
      sql`SELECT * FROM "Payment" WHERE "gatewayOrderId" = ${data.system_order_id}::text LIMIT 1`,
    );
    if (rows[0]) return rows[0];
  }

  // Last resort: our own payment id, sent as metadata on create. Only reached
  // when both references above are absent or unrecognised.
  const metaId = data.metadata && typeof data.metadata === "object"
    ? (data.metadata as Record<string, unknown>).payment_id
    : undefined;
  if (typeof metaId === "string" && metaId.length > 0) {
    const { rows } = await query<PaymentRow>(
      db,
      sql`SELECT * FROM "Payment" WHERE "id" = ${metaId}::text LIMIT 1`,
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/** What SafeUPI itself says about a payment, asked directly. */
export interface GatewayTruth {
  status: PaymentStatus | null;
  amount: number | null;
  utr: string | null;
  customerVpa: string | null;
  systemOrderId: string | null;
}

/**
 * Asks SafeUPI what actually happened to a payment.
 *
 * This is the check that makes an unsigned webhook safe to act on. A forged
 * delivery can claim anything; it cannot make this endpoint agree. Every
 * settlement that releases food goes through here first — see the trust-model
 * note at the top of this module.
 */
export async function fetchGatewayStatus(
  config: PaymentConfig,
  clientTxnId: string,
): Promise<GatewayTruth> {
  const envelope = await callGateway<CheckStatusData>(config, "/api/order/status", {
    merchant_order_id: clientTxnId,
  });
  const data = envelope.data;
  if (!data) return { status: null, amount: null, utr: null, customerVpa: null, systemOrderId: null };

  const amount = Number(data.amount);
  return {
    status: mapGatewayStatus(data.status),
    amount: Number.isFinite(amount) ? amount : null,
    utr: data.payment?.utr ?? null,
    customerVpa: data.payment?.customer_vpa ?? null,
    systemOrderId: data.system_order_id ?? null,
  };
}

/**
 * Applies a webhook, after independently confirming it with SafeUPI.
 *
 * Runs in one transaction and takes `FOR UPDATE` on the payment row, because
 * the gateway may deliver the same event twice concurrently: without the lock
 * both copies would read PENDING, both would pass the idempotency check, and
 * both would confirm the orders. The row lock serialises them, and the second
 * one then sees a terminal status and does nothing.
 *
 * `config` is what separates this from the previous gateway's version. Passing
 * it turns on the Status API confirmation, which is REQUIRED for any outcome
 * that releases food: SafeUPI's webhook is unsigned, so the payload alone is
 * only a claim. Omitting it (the reconciliation path, which already has the
 * gateway's answer in hand) skips the second call rather than making it twice.
 */
export async function applyWebhook(
  pool: Pool,
  payload: WebhookPayload,
  options: { config?: PaymentConfig; alreadyVerified?: boolean } = {},
): Promise<SettlementResult> {
  const claimed = mapGatewayStatus(payload.data?.status ?? payload.event);
  if (!claimed) {
    return {
      changed: false,
      payment: null,
      status: null,
      confirmedOrderIds: [],
      releasedOrderIds: [],
      reason: `unrecognised status "${payload.data?.status ?? payload.event ?? ""}"`,
    };
  }

  /**
   * Ask SafeUPI directly, BEFORE opening the transaction.
   *
   * Before, because this is a network call and holding a row lock across one
   * would pin the payment row for as long as the gateway takes to answer —
   * exactly the mistake the two-statement order path was written to avoid.
   *
   * The gateway's answer replaces the payload's claim outright. A webhook that
   * says "success" against a payment SafeUPI still calls pending settles
   * nothing, which is precisely the forged-delivery case this exists to stop.
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
      // Could not reach SafeUPI. Deliberately settles NOTHING rather than
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
      // Worth shouting about: either SafeUPI changed its mind between sending
      // the webhook and answering us, or the delivery did not come from them.
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

    // Replay guard. SafeUPI sends no idempotency key, so one is derived from
    // the values that are unique to a settled transaction: the outcome plus
    // the bank's UTR. A retry of the same delivery therefore produces the same
    // key and is answered as the no-op it is.
    const deliveryKey = truth?.utr
      ? `${incoming}:${truth.utr}`
      : payload.data?.payment?.utr
        ? `${incoming}:${payload.data.payment.utr}`
        : null;

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
    // a tampered payload that cleared signature checking, and neither may be
    // allowed to release food. Compared in paise to avoid float equality.
    if (incoming === "SUCCESS") {
      const expectedPaise = Math.round(Number(payment.amount) * 100);
      // The gateway's figure, not the payload's — the payload is a claim.
      const paidPaise = Math.round(Number(truth?.amount ?? payload.data?.amount ?? 0) * 100);
      if (paidPaise !== expectedPaise) {
        await query(
          client,
          sql`
            UPDATE "Payment"
               SET "status" = 'FAILED',
                   "failureReason" = ${`amount mismatch: expected ${payment.amount}, gateway reported ${truth?.amount ?? payload.data?.amount}`}::text,
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
          received: truth?.amount ?? payload.data?.amount,
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
               "upiTxnId" = COALESCE(${truth?.utr ?? payload.data?.payment?.utr ?? null}::text, "upiTxnId"),
               "payerVpa" = COALESCE(${truth?.customerVpa ?? payload.data?.payment?.customer_vpa ?? null}::text, "payerVpa"),
               "payerName" = COALESCE(${payload.data?.customer_name ?? null}::text, "payerName"),
               "gatewayOrderId" = COALESCE("gatewayOrderId", ${truth?.systemOrderId ?? payload.data?.system_order_id ?? null}::text),
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
  // `alreadyVerified` because this answer came straight from the Status API —
  // it IS the verification, so asking again would be the same call twice.
  return applyWebhook(
    pool,
    {
      event: truth.status.toLowerCase(),
      data: {
        status: truth.status.toLowerCase(),
        merchant_order_id: payment.clientTxnId,
        system_order_id: truth.systemOrderId ?? payment.gatewayOrderId ?? undefined,
        amount: truth.amount ?? undefined,
        payment: { utr: truth.utr, customer_vpa: truth.customerVpa },
      },
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
