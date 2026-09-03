-- UPI payments via VyaparGateway.
--
-- One Payment covers a whole cart, which may have become more than one Order
-- (a cart spanning both kitchens splits per kitchen — see createOrder). The FK
-- therefore lives on Order, not the other way round: Payment 1 -> N Order.

CREATE TABLE "Payment" (
    "id"                TEXT PRIMARY KEY,

    -- Our idempotent handle on the transaction, sent as client_txn_id. Unique
    -- because it is what a retried create_order call must collide on rather
    -- than silently opening a second order at the gateway.
    "clientTxnId"       TEXT NOT NULL UNIQUE,

    -- The gateway's id, learned from the create_order response. Null until
    -- that call returns; unique once known so a replayed webhook naming an
    -- order we already recorded cannot create a second row.
    "gatewayOrderId"    TEXT UNIQUE,

    -- Cart total in rupees. Numeric, not float: money compared for equality
    -- against the webhook amount must not carry binary rounding error.
    "amount"            NUMERIC(10,2) NOT NULL,
    "currency"          TEXT NOT NULL DEFAULT 'INR',

    -- PENDING | SUCCESS | FAILED | EXPIRED. Mirrors the gateway's vocabulary
    -- minus 'processing', which we fold into PENDING: it carries no decision.
    "status"            TEXT NOT NULL DEFAULT 'PENDING',

    -- Who paid. Exactly one of these is set, matching Order's own ownership
    -- split between an enrolled student and a walk-up guest session.
    "studentId"         TEXT REFERENCES "User"("id") ON DELETE SET NULL,
    "guestSessionId"    TEXT,

    -- Settlement facts, all learned from the webhook and null before it lands.
    "upiTxnId"          TEXT,
    "payerVpa"          TEXT,
    "payerName"         TEXT,

    -- What the gateway handed us, kept verbatim for reconciliation against
    -- their dashboard when a figure is ever disputed.
    "qrCode"            TEXT,
    "upiString"         TEXT,

    "expiresAt"         TIMESTAMP(3),
    "paidAt"            TIMESTAMP(3),
    "failureReason"     TEXT,

    -- Guards replay. The gateway retries a webhook until it is 200-ed, and a
    -- retry must be a no-op, not a second settlement.
    "idempotencyKey"    TEXT UNIQUE,

    -- How many webhook deliveries we accepted for this payment. A value above
    -- 1 means the gateway retried; useful when reading the audit trail.
    "webhookCount"      INTEGER NOT NULL DEFAULT 0,

    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_status_check"
        CHECK ("status" IN ('PENDING','SUCCESS','FAILED','EXPIRED')),

    -- Same one-owner rule Order follows: a payment belongs to a student or to
    -- a guest session, never to both and never to neither.
    CONSTRAINT "Payment_single_owner_check"
        CHECK (num_nonnulls("studentId", "guestSessionId") = 1),

    CONSTRAINT "Payment_amount_positive_check"
        CHECK ("amount" > 0)
);

-- The sweep that expires stale payments scans by (status, expiresAt); the
-- partial index keeps it off the settled majority of the table.
CREATE INDEX "Payment_pending_expiry_idx"
    ON "Payment" ("expiresAt")
    WHERE "status" = 'PENDING';

CREATE INDEX "Payment_studentId_createdAt_idx"
    ON "Payment" ("studentId", "createdAt" DESC);

CREATE INDEX "Payment_guestSessionId_createdAt_idx"
    ON "Payment" ("guestSessionId", "createdAt" DESC);

-- Order -> Payment. ON DELETE SET NULL rather than CASCADE: a deleted payment
-- row must never take a real, cooked, collected order with it.
ALTER TABLE "Order"
    ADD COLUMN "paymentId" TEXT REFERENCES "Payment"("id") ON DELETE SET NULL;

-- Settling one payment updates every order it covers, so look them up by it.
CREATE INDEX "Order_paymentId_idx" ON "Order" ("paymentId");

-- Orders awaiting payment are hidden from the kitchen board until the webhook
-- confirms. Kept as a nullable flag rather than a new Order.status value so
-- that every existing status query, index and state machine keeps working
-- untouched — and so an order placed while payments are switched off is
-- simply NULL here and behaves exactly as it does today.
ALTER TABLE "Order"
    ADD COLUMN "awaitingPayment" BOOLEAN NOT NULL DEFAULT FALSE;

-- The kitchen board filters these out on every read, so index only the few
-- rows that are actually hidden.
CREATE INDEX "Order_awaitingPayment_idx"
    ON "Order" ("awaitingPayment")
    WHERE "awaitingPayment" = TRUE;
