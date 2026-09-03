-- Raw record of every webhook SafeUPI sends us.
--
-- Exists because a payment failing "somewhere between the UPI app and the
-- order" is otherwise unanswerable after the fact: the delivery is the only
-- evidence of what the gateway actually said, and it is gone the moment the
-- request ends. Students report paying while our records and SafeUPI's Status
-- API both say cancelled — without this table there is no way to tell whether
-- a success was ever sent and mishandled, or never sent at all.
--
-- Kept deliberately dumb: it records what arrived, before any interpretation,
-- so it stays trustworthy even when the interpreting code is what is suspect.
CREATE TABLE "WebhookLog" (
    "id"          TEXT PRIMARY KEY,

    -- The event name as sent, unmapped. Nullable because a malformed delivery
    -- is exactly the kind we most want a record of.
    "event"       TEXT,
    -- SafeUPI's data.status, likewise unmapped.
    "status"      TEXT,
    "merchantOrderId" TEXT,
    "systemOrderId"   TEXT,

    -- The whole body, minus the shared secret.
    --
    -- The secret is stripped before this is written: it is a bearer credential
    -- that would otherwise sit in the database in plaintext, readable by
    -- anything that can read the table. Everything else is kept verbatim.
    "payload"     JSONB NOT NULL,

    -- Whether the secret matched. A run of FALSE here means someone is probing
    -- the endpoint, or the dashboard secret has drifted from ours.
    "authenticated" BOOLEAN NOT NULL,
    -- What applyWebhook decided, so a mishandled delivery is visible next to
    -- the raw payload that produced it.
    "outcome"     TEXT,

    "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reads are "what happened to this order", newest first.
CREATE INDEX "WebhookLog_merchantOrderId_idx"
    ON "WebhookLog" ("merchantOrderId", "receivedAt" DESC);

CREATE INDEX "WebhookLog_receivedAt_idx"
    ON "WebhookLog" ("receivedAt" DESC);
