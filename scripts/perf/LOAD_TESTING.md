# Concurrent load test against a deployed environment

Drives ~100 students logging in and ordering, plus admins accepting orders,
concurrently for a fixed window, and reports latency percentiles and an error
breakdown per endpoint.

Two scripts:

| Script | Does |
|---|---|
| `makeLoadTestUsers.ts` | Creates dedicated `LOADTEST-*` student accounts and writes the credentials file. Also deletes them again. |
| `prodLoadTest.ts` | The load run itself. Pure HTTP client — never opens a database connection. |

## Why this is not a vitest test

The vitest suite cannot be aimed at production by design, and that guard is
worth keeping. `tests/setup/databaseGuard.ts` refuses any connection string
naming the live host, and `tests/setup/marker.ts` additionally requires a
`klh_test_guard.marker` table that only exists in a freshly-migrated,
never-used database. See `TESTING.md`.

`prodLoadTest.ts` does not weaken any of that, because it never connects to the
database at all. It talks HTTPS to the deployed API exactly as a browser does,
so the only access it has is access the API already grants to anyone holding a
valid login.

## Before you run it against production

Read this part.

- Orders created are **real rows** on the live kitchen board. Kitchen staff will
  see them.
- With `--deliver`, each delivery performs a **real, irreversible `stockQty`
  decrement**. Without it, orders stop at `COOKED` and no stock is spent. It is
  off by default.
- Real Telegram messages are sent to any linked student. The `LOADTEST-*`
  accounts are never linked, so in practice this is silent — but it is why you
  should load with the generated accounts rather than real students'.
- Audit-log rows are written for admin actions.

**Rate limits cap what you can observe.** `POST /orders` allows 5/min per
identity and the global limit is 100/min per identity (`src/app.ts`,
`src/routes/orders.ts`). With 100 users on a 12s think time you will see 429s.
That is the limiter working correctly, and the report says so explicitly. Raise
those limits deliberately if you want to measure past them.

## Run it

```bash
cd backend

# 1. Create 100 load-test accounts + credentials file
npx tsx scripts/perf/makeLoadTestUsers.ts --count 100 --out loadtest-users.json

# 2. Admin credentials, by hand, in their own file (an existing admin login)
#    [{ "identifier": "admin@klh", "password": "...", "school": "KLH" }]

# 3. Dry run first — prints the plan, sends nothing
npx tsx scripts/perf/prodLoadTest.ts --dry-run \
  --api https://<your-worker>.workers.dev \
  --users loadtest-users.json --admin-creds loadtest-admin.json

# 4. The real run
LOAD_TEST_CONFIRM="I understand this writes to https://<your-worker>.workers.dev" \
npx tsx scripts/perf/prodLoadTest.ts \
  --api https://<your-worker>.workers.dev \
  --users loadtest-users.json --admin-creds loadtest-admin.json \
  --duration 120 --concurrency 100

# 5. Clean up
npx tsx scripts/cleanTestOrders.ts --apply
npx tsx scripts/perf/makeLoadTestUsers.ts --cleanup
rm loadtest-users.json loadtest-admin.json
```

`--api` is the **backend** origin (the Cloudflare Worker), not the frontend
site. `https://rajasbakery.in` is the frontend and serves no API routes;
pointing the script there returns 404s for everything.

## Safety gates

- **Typed confirmation.** Any non-local target requires
  `LOAD_TEST_CONFIRM` to exactly equal `I understand this writes to <apiUrl>`.
  A typo'd host therefore cannot be loaded against by accident, and the
  confirmation cannot be satisfied by copying a single word.
- **HTTPS enforced** for non-local targets, since every login puts a real
  plaintext password in a request body.
- **No delivery by default** — `--deliver` is opt-in, so a default run spends
  no stock.
- **Item allowlist** — `--items id1,id2` restricts ordering to named items, so
  a run cannot drain every popular item and leave real students unable to order.
- **Credentials never printed.** No password or bearer token reaches stdout,
  the failure tally, the report, or any error message.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--api` | (required) | Backend origin. `LOAD_TEST_API_URL` also works. |
| `--users` | (required) | Student credentials JSON. |
| `--admin-creds` | none | Admin credentials JSON. Without it, orders are created but never accepted. |
| `--duration` | `120` | Run length, seconds. |
| `--concurrency` | `100` | How many students from the file to use. |
| `--think` | `12` | Seconds between a student's orders, jittered 0.5x–1.5x. |
| `--admin-interval` | `1000` | Milliseconds between admin board polls. |
| `--items-per-order` | `1` | Distinct items per order. |
| `--qty` | `1` | Quantity per line. |
| `--items` | none | Allowlist of menu item ids or names. |
| `--deliver` | off | Advance to DELIVERED. **Spends real stock.** |
| `--dry-run` | off | Print the plan, send nothing. |
| `--login-ramp` | `10` | Seconds to spread logins across. |
| `--max-orders-per-user` | `50` | Per-user cap on orders placed. |
| `--timeout` | `30` | Per-request timeout, seconds. |

The login ramp is not politeness: a simultaneous 100-way login burst is a
bcrypt-bound thundering herd that measures the login endpoint rather than the
ordering path, and leaves the steady state unreadable.

## Reading the output

Per-endpoint `n / ok% / p50 / p95 / p99 / max / rps`, then failures grouped by
operation, HTTP status, and application error code.

Codes worth recognising:

| Code | Means |
|---|---|
| `TOO_MANY_ORDERS` | Per-identity order limit (5/min). Expected. |
| `TOO_MANY_REQUESTS` | Global limit (100/min). Expected under load. |
| `MUST_CHANGE_PASSWORD` | Account is flagged; its token cannot order. Counted as a login failure, not a session. |
| (slow logins, no error) | Login never rejects — it applies a progressive delay instead, capped at 30s. A `POST /auth/login` p99 in the tens of seconds means wrong passwords in the credentials file, not a slow server. |
| `INVALID_TRANSITION` | Two admins raced the same order. See below. |
| `OUT_OF_STOCK` | Items genuinely drained. Use `--items` next time. |
| `TIMEOUT` / `NETWORK_ERROR` | Transport failure, recorded as status 0. |

With more than one admin, both poll the same board and can race to PATCH the
same order, producing some `409 INVALID_TRANSITION`. Those are the harness
competing with itself, not a server defect — run a single admin if you want a
clean error column.
