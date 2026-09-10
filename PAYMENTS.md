# UPI Payments (GuruPay)

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
GuruPay create-order → payment_url
      │
      ▼
browser redirected to GuruPay's hosted page
      │
      ├── student pays ──► webhook "payment.success"  (UNSIGNED — trusted for
      │                      │                          nothing but the order_id)
      │                      ├─ ASK GuruPay's check-status API what really happened
      │                      ├─ check amount matches to the paisa
      │                      └─ awaitingPayment = FALSE → kitchen sees it
      │
      └── returns to /payment/complete ──► page polls our backend
                                            (never trusts the URL)
```

An order with `awaitingPayment = TRUE` holds its stock but is invisible to the
kitchen, to admin stats, and to status transitions. It becomes real only when
`applyWebhook` independently confirms the money against GuruPay's own records.

## The trust model, and why there is an extra call

GuruPay **signs nothing**. There is no shared secret, no HMAC header, no way
at all to tell a genuine delivery from a POST anyone could send by hand to
`/payments/webhook` with a guessed or observed `order_id`.

So a webhook here is never trusted with a decision. The payload is used for
exactly one thing — looking up which `Payment` it claims to be about — and
never to decide that payment's outcome. Before any order is released,
`applyWebhook` calls GuruPay's check-status API and uses *that* answer,
discarding whatever the payload claimed outright. A forged or replayed
delivery therefore accomplishes nothing on its own; an attacker would also
have to make GuruPay's own records say "success".

`Payment.verifiedViaStatusApi` records that the check-status call actually
ran, so a settlement made on the payload alone — which should never happen —
would be visible rather than silent.

## Configuration

Both the flag **and** the credential are required, or payments read as off — a
flag-only deploy presents no checkout rather than one that cannot settle.

| Name | Where | What |
|---|---|---|
| `PAYMENTS_ENABLED` | `wrangler.jsonc` vars | `"true"` to enable |
| `GURUPAY_API_KEY` | **secret** | merchant API key, sent as the `X-Guru-Key` header |
| `GURUPAY_REDIRECT_URL` | `wrangler.jsonc` vars | where the browser returns |

```bash
npx wrangler secret put GURUPAY_API_KEY
```

The API key travels in a header rather than a request body — a meaningfully
better place for a credential than the previous gateway's body-field scheme,
since bodies are what get logged and echoed back in error reports. Even so,
nothing in `paymentService.ts` logs a request body, only responses.

## The webhook URL

GuruPay asks for an HTTPS URL that accepts POST. That endpoint already exists:

```
https://<your-worker>.workers.dev/payments/webhook
```

It is an API route, not a page. It must be reachable from the public internet —
GuruPay's servers call it, not the browser — so `localhost` cannot work. For
local development, tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
# paste the printed https URL + /payments/webhook into GuruPay's dashboard
```

The redirect URL is separate and points at the **frontend**:

```
https://your-frontend/payment/complete
```

The payment id is appended automatically at create time.

## What protects the money

| Risk | Defence |
|---|---|
| Forged or replayed webhook | The payload decides nothing by itself — every outcome is confirmed against check-status |
| Replayed delivery | Idempotency key derived from outcome + UTR, plus a terminal-status check under `FOR UPDATE` |
| Tampered amount | The **gateway's** amount compared to the stored amount in paise |
| Client-set price | Amount summed server-side from the order rows; the client never sends one |
| Paying for someone else's order | Checkout query is owner-scoped; a non-matching order is simply not found |
| Concurrent duplicate webhooks | `SELECT ... FOR UPDATE` serialises them; the second sees a terminal status |
| Overselling during payment | Stock is reserved at checkout, before the student leaves |
| Stranded stock | A failed checkout releases immediately; the expiry sweep catches the rest |
| Free food from an unpaid order | `awaitingPayment` hides it from the board and blocks status transitions |
| Faked return to `/payment/complete` | The page reads no outcome from the URL; it always asks the server |

## Testing without a live merchant

`create-order` is the only call that needs a connected GuruPay merchant.
Everything after the money moves is ours and is tested offline in
`tests/paymentSettlement.test.ts`, which stubs `check-status` so both sides —
the delivery and the gateway's answer — can be controlled independently.

```bash
npm run test:db:up     # postgres + neon wsproxy, in Docker
npm test
npm run test:db:down
```

Cases include: an unpaid order stays hidden while holding stock; a confirmed
webhook releases it; a replay is a no-op; an amount mismatch is refused; a
failure returns the stock; a late failure does not un-confirm a success; **a
well-formed webhook the gateway disagrees with releases nothing**; and an
unreachable gateway releases nothing.

## Rollout

1. Deploy with `PAYMENTS_ENABLED: "false"` — nothing changes for anyone.
2. Run the migrations: `npm run migrate:deploy`.
3. Set the secret (`GURUPAY_API_KEY`).
4. Point GuruPay's webhook at `/payments/webhook` and its redirect at the
   frontend's `/payment/complete`.
5. Flip `PAYMENTS_ENABLED` to `"true"` and redeploy.
6. Test with a real ₹1 order before opening it to students.

To roll back, set the flag to `"false"` and redeploy. The columns stay; orders
placed while it was on keep their payment history.

**Migrating from a prior gateway**: `PAYMENTS_ENABLED` staying `"true"` across
a gateway swap means checkout goes dark the instant the old secret stops being
read by the new code, until the new one is set — a safe failure (checkout
503s, ordering-without-payment still works if the flag itself is flipped off),
but not a silent one. Set the new secret *before* or *during* the same deploy
that ships the code, not after.

## A note on `RETURNING`

`releaseOrdersForPayment` is two statements rather than one clever CTE, and the
comment there explains why. Two Postgres behaviours bit during development:

- `RETURNING` yields **post-update** values, so a predicate like
  `stockSettledAt IS NULL` evaluated there is always false when the same
  statement just stamped it. The gate belongs in `WHERE`.
- A data-modifying CTE **only runs if the main query can reach it**. A stock
  update in a CTE that nothing selects from is silently never executed.

Either mistake looks like an ordinary cancel while quietly stranding inventory
forever. Both were caught by running the SQL against a real Postgres.
