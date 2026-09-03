# UPI Payments (SafeUPI)

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
SafeUPI order/create → payment.url
      │
      ▼
browser redirected to SafeUPI's hosted page
      │
      ├── student pays ──► webhook "success"
      │                      ├─ compare the shared secret
      │                      ├─ ASK SafeUPI's Status API what really happened
      │                      ├─ check amount matches to the paisa
      │                      └─ awaitingPayment = FALSE → kitchen sees it
      │
      └── returns to /payment/complete ──► page polls our backend
                                            (never trusts the URL)
```

An order with `awaitingPayment = TRUE` holds its stock but is invisible to the
kitchen, to admin stats, and to status transitions. It becomes real only when a
**verified** webhook confirms the money.

## The trust model, and why there is an extra call

SafeUPI does **not sign its webhooks**. It echoes a shared secret in the request
body and expects the receiver to compare it. That is a bearer check: it proves
the sender knew the secret, and nothing about whether the payload is true.
Anything that ever sees one delivery — a log line, a proxy, a misrouted
request — learns the secret and can then forge a `success` for any order.

So a webhook is treated as **a hint that something happened**, never as proof
that it did. Before any order is released, `applyWebhook` calls SafeUPI's Status
API and uses *that* answer, discarding whatever the payload claimed. Forging a
delivery is therefore not enough; an attacker would also have to fool SafeUPI.

`Payment.verifiedViaStatusApi` records that the second check actually ran, so a
settlement made on a webhook alone would be visible rather than silent.

## Configuration

Both the flag **and** the credentials are required, or payments read as off — a
flag-only deploy presents no checkout rather than one that cannot settle.

| Name | Where | What |
|---|---|---|
| `PAYMENTS_ENABLED` | `wrangler.jsonc` vars | `"true"` to enable |
| `SAFEUPI_API_SECRET` | **secret** | API key, sent as `secret` in each body |
| `SAFEUPI_WEBHOOK_SECRET` | **secret** | the value SafeUPI echoes back |
| `SAFEUPI_REDIRECT_URL` | `wrangler.jsonc` vars | where the browser returns |
| `SAFEUPI_MERCHANT_ID` | optional | route to a specific merchant |

```bash
npx wrangler secret put SAFEUPI_API_SECRET
npx wrangler secret put SAFEUPI_WEBHOOK_SECRET
```

Both are bearer credentials that travel in request bodies, which is why nothing
in `paymentService.ts` ever logs a request body — only responses.

## The webhook URL

SafeUPI asks for an HTTPS URL that accepts POST. That endpoint already exists:

```
https://<your-worker>.workers.dev/payments/webhook
```

It is an API route, not a page. It must be reachable from the public internet —
SafeUPI's servers call it, not the browser — so `localhost` cannot work. For
local development, tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
# paste the printed https URL + /payments/webhook into SafeUPI's dashboard
```

The redirect URL is separate and points at the **frontend**:

```
https://your-frontend/payment/complete
```

The payment id is appended automatically at create time.

## What protects the money

| Risk | Defence |
|---|---|
| Forged webhook | Shared secret compared in constant time, **then** confirmed against the Status API |
| Leaked webhook secret | Still not enough — the Status API must also agree |
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

`order/create` is the only call that needs a connected SafeUPI merchant.
Everything after the money moves is ours and is tested offline in
`tests/paymentSettlement.test.ts`, which stubs the Status API so both sides —
the delivery and the gateway's answer — can be controlled independently.

```bash
npm run test:db:up     # postgres + neon wsproxy, in Docker
npm test
npm run test:db:down
```

Cases include: an unpaid order stays hidden while holding stock; a confirmed
webhook releases it; a replay is a no-op; an amount mismatch is refused; a
failure returns the stock; a late failure does not un-confirm a success; a wrong
secret changes nothing; **a well-formed webhook the gateway disagrees with
releases nothing**; and an unreachable gateway releases nothing.

## Rollout

1. Deploy with `PAYMENTS_ENABLED: "false"` — nothing changes for anyone.
2. Run the migrations: `npm run migrate:deploy`.
3. Set both secrets.
4. Point SafeUPI's webhook at `/payments/webhook` and its redirect at the
   frontend's `/payment/complete`.
5. Flip `PAYMENTS_ENABLED` to `"true"` and redeploy.
6. Test with a real ₹1 order before opening it to students.

To roll back, set the flag to `"false"` and redeploy. The columns stay; orders
placed while it was on keep their payment history.

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
