# UPI Payments (VyaparGateway)

Online payment for canteen orders, behind a feature flag that is **off by
default**. With it off, ordering behaves exactly as it did before payments
existed.

## How it fits together

A cart that spans both kitchens becomes two orders but is paid for once, so a
`Payment` covers one-to-many `Order` rows and the FK lives on `Order`.

```
student places cart
      │
      ▼
createOrder(awaitingPayment: true)      ← stock is CLAIMED here
      │                                   (nobody can buy it out from under them)
      ▼
POST /payments/checkout                 ← amount summed from the order rows,
      │                                   never taken from the client
      ▼
gateway create_order → QR + 2-min window
      │
      ├── student pays ──► webhook "payment.success"
      │                      ├─ verify HMAC over the RAW body
      │                      ├─ check amount matches to the paisa
      │                      ├─ awaitingPayment = FALSE  → kitchen sees it
      │                      └─ reservation left intact for delivery
      │
      └── window lapses ──► expiry sweep / "payment.failed"
                             ├─ orders CANCELLED
                             └─ reservedQty given back
```

An order with `awaitingPayment = TRUE` holds its stock but is invisible to the
kitchen board, to admin stats, and to status transitions. It becomes real only
when a verified webhook confirms the money.

## Configuration

Two things are required, and **both** must be present or payments read as off —
a flag-only deploy presents no checkout rather than one that cannot settle.

| Name | Where | What |
|---|---|---|
| `PAYMENTS_ENABLED` | `wrangler.jsonc` vars | `"true"` to enable |
| `VYAPAR_API_KEY` | **secret** | `vg_live_...` from the dashboard |
| `VYAPAR_WEBHOOK_SECRET` | **secret** | `whsec_...` — the HMAC key |
| `VYAPAR_CALLBACK_URL` | `wrangler.jsonc` vars | our public webhook URL |
| `VYAPAR_REDIRECT_URL` | optional | post-payment browser redirect |

```bash
npx wrangler secret put VYAPAR_API_KEY
npx wrangler secret put VYAPAR_WEBHOOK_SECRET
```

`VYAPAR_WEBHOOK_SECRET` is the only thing separating a genuine
`payment.success` from anyone who has guessed the webhook URL. Treat it exactly
like a password: never in `wrangler.jsonc`, never in a commit, never in a
screenshot. If it is ever exposed, rotate it in the dashboard immediately.

## The webhook URL

Set it in the dashboard **and** in `VYAPAR_CALLBACK_URL`. The per-order
`callback_url` we send takes precedence, which lets a staging deploy receive
its own webhooks without disturbing production.

```
https://<your-worker>.workers.dev/payments/webhook
```

It must be publicly reachable over HTTPS — the gateway's servers call it, not
the browser, so `localhost` cannot work. For local development, tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
# paste the printed https URL + /payments/webhook into VYAPAR_CALLBACK_URL
```

## Signature verification

The gateway signs `{timestamp}.{raw_body}` with HMAC-SHA256.

**Sign the raw bytes exactly as received.** The sample code on the dashboard's
integration page re-serializes the parsed JSON before signing
(`json.dumps(payload, sort_keys=True, ...)`) — that produces a different string
than the one that was signed, because key order, separators, unicode escaping
and float formatting all differ between serializers. The API documentation says
to use the raw body, and that is what `routes/payments.ts` does via
`c.req.text()`. `tests/unit/paymentWebhook.test.ts` pins this with a case that
fails if anyone switches it to `c.req.json()`.

Verification also bounds the timestamp to ±5 minutes. A signature never expires
on its own, so without that bound a single captured delivery could be replayed
indefinitely.

## What protects the money

| Risk | Defence |
|---|---|
| Forged webhook | HMAC-SHA256 over the raw body, checked before parsing |
| Replayed delivery | Timestamp tolerance + `idempotencyKey` + terminal-status check under `FOR UPDATE` |
| Tampered amount | Webhook amount compared to the stored amount in paise; a mismatch fails the payment |
| Client-set price | Amount is summed server-side from the order rows; the client never sends one |
| Paying for someone else's order | Checkout query is owner-scoped; a non-matching order is simply not found |
| Concurrent duplicate webhooks | `SELECT ... FOR UPDATE` serialises them; the second sees a terminal status |
| Overselling during payment | Stock is reserved at checkout, before the QR is shown |
| Stranded stock | Expiry sweep cancels lapsed payments and hands portions back |
| Free food from an unpaid order | `awaitingPayment` hides it from the board and blocks status transitions |

## Rollout

1. Deploy with `PAYMENTS_ENABLED: "false"` — nothing changes for anyone.
2. Run the migration: `npm run migrate:deploy`.
3. Set both secrets.
4. Point the dashboard webhook at `/payments/webhook`.
5. Flip `PAYMENTS_ENABLED` to `"true"` and redeploy.
6. Test with a real ₹1 order before opening it to students.

To roll back, set the flag to `"false"` and redeploy. The column stays; orders
placed while it was on keep their payment history.

## Testing without a merchant

`create_order` is the only call that needs a live VyaparGateway merchant. Every
step after the money moves — the part that actually releases food — is ours and
is tested offline in `tests/paymentSettlement.test.ts`, by signing webhooks with
the test secret and posting them at the real endpoint.

```bash
npm run test:db:up     # postgres + neon wsproxy, in Docker
npm test
npm run test:db:down
```

Nine cases, all against a real Postgres:

| Case | Asserted |
|---|---|
| Unpaid order | Hidden from the board, stock still held |
| `payment.success` | Order confirmed, reservation intact, status still PENDING |
| Replayed delivery | No-op; `webhookCount` stays 1, stock unmoved |
| Amount mismatch | Payment FAILED, order cancelled, stock returned |
| `payment.failed` | Order cancelled, `reservedQty` back to 0 |
| Late failure after success | Success stands; a cooking order is never un-confirmed |
| Forged signature | 401, nothing changes — the test that matters most |
| Stale timestamp | 401 even with a valid signature |
| Unknown payment | 200, ignored |

The suite needs two containers because `@neondatabase/serverless` speaks
WebSockets, not the raw Postgres protocol — `neondatabase/wsproxy` bridges
them, and `tests/setup/testEnv.ts` points the driver at it for local targets
only. A remote Neon branch is left alone.

## A note on `RETURNING`

`releaseOrdersForPayment` is two statements rather than one clever CTE, and the
comment there explains why. Two Postgres behaviours bit during development and
are worth knowing before editing that function:

- `RETURNING` yields **post-update** values, so a predicate like
  `stockSettledAt IS NULL` evaluated there is always false when the same
  statement just stamped it. The gate belongs in `WHERE`.
- A data-modifying CTE **only runs if the main query can reach it**. A stock
  update in a CTE that nothing selects from is silently never executed.

Either mistake looks like an ordinary cancel while quietly stranding inventory
forever. Both were caught by running the SQL against a real Postgres.
