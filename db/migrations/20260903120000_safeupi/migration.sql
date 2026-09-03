-- Move the payment gateway from VyaparGateway to SafeUPI.
--
-- The Payment table itself carries over almost unchanged: SafeUPI's
-- merchant_order_id is our clientTxnId, its system_order_id is our
-- gatewayOrderId, and its utr is our upiTxnId. Only the checkout flow differs,
-- and that is what these columns are for.

-- Where to send the student to pay. SafeUPI's hosted page rather than a QR we
-- render ourselves, so the payment URL is the thing the client actually needs
-- back from checkout. Nullable because it is only known after create returns.
ALTER TABLE "Payment"
    ADD COLUMN "paymentUrl" TEXT;

-- The connected merchant SafeUPI routed this payment to, and the sha256 of
-- that merchant's UPI ID.
--
-- The hash is not decoration: SafeUPI documents it as the value to check so a
-- response can be confirmed as coming from the merchant we expect. Storing it
-- per payment is what makes a later dispute answerable — "which merchant was
-- this routed to, and was it ours" is otherwise unanswerable after the fact.
ALTER TABLE "Payment"
    ADD COLUMN "linkedMerchantId" TEXT;
ALTER TABLE "Payment"
    ADD COLUMN "merchantUpiHash" TEXT;

-- SafeUPI's webhook carries no signature — it echoes a shared secret in the
-- body instead. A leaked secret would therefore be enough to forge a success,
-- so every settlement is independently confirmed against the Status API before
-- any food is released. This records that the second check actually happened,
-- so a payment confirmed on the webhook alone is visible rather than silent.
ALTER TABLE "Payment"
    ADD COLUMN "verifiedViaStatusApi" BOOLEAN NOT NULL DEFAULT FALSE;
