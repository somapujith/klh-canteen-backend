-- Move the payment gateway from SafeUPI to GuruPay.
--
-- GuruPay's order_id is our clientTxnId, its utr is our upiTxnId, its
-- payment_url is our Payment.paymentUrl (kept, unchanged in meaning).
-- SafeUPI's merchant-fallback concepts have no GuruPay equivalent — GuruPay
-- routes through a single configured merchant account — and are dropped.
ALTER TABLE "Payment" DROP COLUMN "linkedMerchantId";
ALTER TABLE "Payment" DROP COLUMN "merchantUpiHash";

-- No GuruPay equivalent (no embedded-checkout QR response), and qrCode was
-- the field the removed embedded-SDK modal path read. upiString has been
-- dead since before SafeUPI — declared and serialized but never written by
-- any gateway this codebase has used.
ALTER TABLE "Payment" DROP COLUMN "qrCode";
ALTER TABLE "Payment" DROP COLUMN "upiString";

-- verifiedViaStatusApi and paymentUrl are unchanged: GuruPay also exposes a
-- check-status endpoint that every settlement is still confirmed against
-- before food is released, and also returns a hosted payment_url.
