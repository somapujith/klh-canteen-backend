# Testing

## Read this first

On 2026-08-23 someone ran `npm test` against the shared **live** Neon database.
The suite's cleanup hooks called `deleteMany()` on every table, and three admin
accounts, a student account and the entire menu were deleted mid-session. The
suite has been off-limits ever since, which left roughly 2,000 lines of new
backend code with no automated coverage.

That cannot happen again, and not because of a convention. The suite now
**mechanically refuses** to run against anything that has not proved it is a
disposable test database.

---

## Quick start

```bash
cp .env.test.example .env.test   # once
npm run test:db:up               # starts Postgres + the Neon WS proxy, migrates
npm test
```

Tear down when you are done:

```bash
npm run test:db:down             # removes the containers and their data
```

| Script | What it does |
| --- | --- |
| `npm test` | Runs the suite. Safe with `.env` present. |
| `npm run test:watch` | Same, in watch mode. |
| `npm run test:db:up` | Starts the test containers and applies migrations. |
| `npm run test:db:down` | Destroys the test containers and their volumes. |
| `npm run test:db:reset` | `down` then `up` — a guaranteed-clean database. |
| `npm run test:db:migrate` | Applies migrations to the test database only. |
| `npm run typecheck:tests` | Typechecks `src` + `tests` together. |

---

## How the guard works

Three independent layers. All of them must pass; any one of them failing aborts
the run with a banner, never a warning.

### Layer 0 — the suite never reads `DATABASE_URL` from the environment

`tests/setup/testEnv.ts` **deletes** any inherited `DATABASE_URL` before
anything can read it, and never loads `.env`. A database URL is only accepted
from one of two places, neither of which `.env` can occupy:

1. `TEST_DATABASE_URL` — explicit, used by CI.
2. `.env.test` — the local developer path, loaded with `override: true`.

If neither is present, the suite runs with **no** database: the
database-backed tests skip with the reason printed, and nothing falls through
to `.env`.

### Layer 1 — static checks on the connection string

`tests/setup/databaseGuard.ts`, run before a single socket is opened:

* the URL must not name the same `host:port/database` as any `DATABASE_URL`
  found in `.env`, `.env.local`, `.env.production` or `.env.development` —
  credentials are ignored in this comparison, so re-writing the username does
  not get you past it;
* the database name must contain `test` (`neondb` therefore cannot pass);
* the host must be local or a CI service host (`localhost`, `127.0.0.1`,
  `host.docker.internal`, `postgres`, `db`, …). Anything else additionally
  requires `ALLOW_REMOTE_TEST_DATABASE=1`;
* passwords are redacted from every message the guard prints.

### Layer 2 — a physical marker inside the database

`tests/setup/marker.ts` requires the table **`klh_test_guard.marker`** to exist
in the target database.

* It is created by this suite and by nothing else.
* It is only ever created into a database containing **zero users and zero
  orders** — a database that has just been migrated and never used.
* The live database has 154 users and 191 orders, so it can never acquire the
  marker, and therefore can never pass this check — even if someone crafted a
  connection string that satisfied every rule in Layer 1.
* It lives in its own schema so `prisma db push` (see *Known issues*) cannot
  drop it.

### Where the layers run

* `globalSetup` (vitest main process, before any worker exists) — Layers 0, 1,
  then migrations, then Layer 2's claim.
* `setupFiles` (every worker, before each test module is evaluated, i.e. before
  a single `beforeAll`/`beforeEach` is even registered) — Layers 0, 1 and a
  re-verification of Layer 2.
* `tests/helpers/db.ts` is the only door to the database. It refuses to hand out
  a `PrismaClient`, and `resetDatabase()` refuses to delete anything, until the
  setup file has signed off.

`tests/databaseGuard.test.ts` is the regression test for all of this. It reads
the **actual** live URL out of `.env` at run time and asserts the guard refuses
it, so it keeps protecting whatever `.env` points at in future.

### Proof

```
$ TEST_DATABASE_URL="<the URL from .env>" npx vitest run
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  REFUSING TO RUN TESTS — UNSAFE DATABASE TARGET                       !!
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

  reason : DATABASE_URL is the SAME DATABASE that .env points at — this is the live database
  target : postgresql://<user>:********@<your-project>.neon.tech/neondb?sslmode=require
exit=1
```

```
$ mv .env.test .env.test.bak && DATABASE_URL="<the URL from .env>" npx vitest run
  NO TEST DATABASE — database-backed tests will SKIP.
  No test database configured. (A DATABASE_URL was inherited from the environment
  and was DISCARDED — the suite never uses it.)
```

```
$ # a database whose NAME passes every string rule, but which holds one real user
$ TEST_DATABASE_URL="postgresql://klh_test:...@localhost:55433/fake_test_prod" npx vitest run
  reason : database already contains real data (1 users, 0 orders) and has no test marker
exit=1
```

---

## The test database

### Option A — local Docker (default, no credentials, works offline)

`docker-compose.test.yml` runs two containers:

| Service | Port | Why |
| --- | --- | --- |
| `postgres-test` | 55433 | The database. Uses `tmpfs`, so nothing survives a `down`. |
| `wsproxy-test` | 55480 | The app talks to Postgres through `@neondatabase/serverless`, which speaks the Postgres protocol over a **WebSocket**, not raw TCP. This terminates the WebSocket and forwards to Postgres. Without it the driver cannot reach a plain local Postgres at all. |

Ports are deliberately different from `docker-compose.yml` (the dev database on
5433) so the two can never be confused or collide.

### Option B — a dedicated Neon branch

Only if you cannot run Docker.

1. In the Neon console, create a **branch** — never `main`/production.
2. Give it a database whose name contains `test` (e.g. `klh_test`). A branch
   whose database is still called `neondb` will be refused.
3. In `.env.test`:
   ```
   DATABASE_URL="postgresql://<user>:********@<your-project>.neon.tech/neondb?sslmode=require"
   ALLOW_REMOTE_TEST_DATABASE=1
   ```
   Leave `NEON_WS_PROXY` unset — a real Neon endpoint terminates WebSockets itself.
4. **Add `.env.test` to `.gitignore` first.** The committed `.env.test` contains
   only throwaway local Docker credentials; a Neon connection string is a secret.

The guard still refuses the URL if it matches `.env`, and the marker check still
requires the branch to have been empty when the suite first claimed it.

### Schema setup

`globalSetup` runs `prisma migrate deploy` against the test URL on every run
(set `SKIP_TEST_MIGRATIONS=1` to skip it once the schema is settled). It passes
`DATABASE_URL` explicitly *and* repoints `DOTENV_CONFIG_PATH` at `.env.test`,
because `prisma.config.ts` does `import "dotenv/config"` and would otherwise
read `.env`.

### Cleanup between tests

`resetDatabase()` `TRUNCATE`s every table in the `public` schema except
`_prisma_migrations`, rather than running a hand-maintained list of
`deleteMany()` calls. The schema is changing weekly right now, and a hardcoded
list silently stops cleaning newly added tables — which shows up later as
cross-test pollution nobody can reproduce.

---

## What is covered

| Area | File | Notes |
| --- | --- | --- |
| The guard itself | `tests/databaseGuard.test.ts` | Refuses the real `.env` URL, non-test names, un-opted-in remotes; redacts passwords. |
| Migrations reproduce the schema | `tests/schemaDrift.test.ts` | **Currently failing on purpose** — see *Known issues*. |
| Guest sessions (crypto) | `tests/guestOrdering.test.ts` | Round-trip, tampered signature, wrong secret, swapped session id, order-QR replayed as a session, expired, future-dated, garbage. |
| Guest ordering + **isolation** | `tests/guestOrdering.test.ts` | Session A gets a **404** — byte-identical to a non-existent id — for session B's order; no header → 401; forged/expired/wrong-secret token → 401; a guest cannot reach a student's order; the session id is never echoed back. |
| Pre-booking | `tests/preBooking.test.ts` | Slot flooring; `COLLECTION_WINDOW_PAST`; `COLLECTION_WINDOW_TOO_FAR`; omitting `collectionAt` means ASAP (`NULL`) and takes no seat; a full window returns 409 `COLLECTION_WINDOW_FULL`; **12 concurrent bookings for 3 seats admit exactly 3**; a two-kitchen cart books both kitchens or neither. |
| Admin pagination | `tests/adminOrdersPagination.test.ts` | Bare-array default (+ `X-Next-Cursor` / `X-Has-More` / `Access-Control-Expose-Headers`); `?format=envelope`; cursor walking with no duplicates or gaps; the keyset property (an order arriving mid-scroll does not push a row off the next page); active-only default; `?active=false`; status filter; page-size ceiling; malformed cursor → 400; kitchen scoping. |
| Guest orders in admin views | `tests/adminOrdersPagination.test.ts` | `studentId = NULL` rows list, open and advance without crashing; `customer.type === "GUEST"`; anonymous guests get a label; the session id is never leaked to an admin. |
| Identity rate limiting | `tests/rateLimitIdentity.test.ts` | **No lockout**: the correct password still works after 10 wrong ones; login never returns 429; one student's failures never touch another's counter; counters are keyed on the normalised identity and nothing network-derived; a successful login clears the counter. Also: the `reject` strategy *does* 429 the 6th guest order, and anonymous traffic is not limited by network address. |
| Pre-existing suites | `auth`, `menu`, `orders`, `adminOrders`, `studentImport`, `orderToken` | Ported onto the guarded helpers; no test touches the database except through `tests/helpers/db.ts`. |

## What is **not** covered, and why

* **Real Durable Object semantics.** The rate limiter no-ops entirely when
  `RATE_LIMITER_HUB` is unbound, which is the case under plain Node — so those
  tests would otherwise pass by doing nothing. They use
  `tests/helpers/fakeRateLimiterHub.ts`, an in-process implementation of the
  DO's actual wire contract (`POST /consume`, `POST /reset`, fixed window,
  post-increment count), copied from `src/durableObjects/rateLimiterHub.ts`.
  The middleware, routes, auth service and database are all real; only the
  collaborator is substituted. What this **cannot** prove: the DO's input-gate
  atomicity under genuine concurrency, alarm-based sweeping, and the fact that
  `env(c)` resolves to `c.env` on workerd. Covering those needs
  `@cloudflare/vitest-pool-workers`.
* **The realtime layer** (`OrderEventsHub`, SSE/WebSocket fan-out, coalescing,
  resume cursors). Same reason: it is Durable Object code. Under Node the hub
  binding is absent and every emit is a no-op, so anything "testable" here today
  would be theatre. This needs `vitest-pool-workers` and is the largest
  remaining gap.
* **`prisma migrate diff` in CI without a database.** The drift check needs a
  live target, so it runs as part of the suite rather than as a standalone step.

---

## Known issues found by re-enabling the suite

### 1. `prisma/migrations` does not reproduce `prisma/schema.prisma` (open)

`tests/schemaDrift.test.ts` fails. A database built from the migration history
alone is missing:

```sql
ALTER TYPE "OrderStatus" ADD VALUE 'PREPARING';
ALTER TYPE "OrderStatus" ADD VALUE 'COOKED';
ALTER TABLE "Order" ADD COLUMN "seenAt" TIMESTAMP(3),
                   ADD COLUMN "seenByAdmin" BOOLEAN NOT NULL DEFAULT false;
```

These exist in `schema.prisma` and in the running database, but in no
migration — the signature of a `db push` against a live database. Consequences:
a new environment, a disaster-recovery restore or a fresh Neon branch comes up
with a schema that **cannot even represent the `PREPARING` and `COOKED` order
statuses**.

The test bootstrap reconciles the test database with `prisma db push` so the
suite can run, and prints the drift. Production databases are not
self-healing. **Fix by writing the missing migration** (`prisma/` is owned by
the schema/service work, not by the test harness); the drift test goes green on
its own once that lands.

### 2. Stale assumptions in two pre-existing tests (fixed here)

* `orders.test.ts` and `adminOrders.test.ts` asserted a PNG QR data URL;
  `src/lib/qr.ts` returns SVG (rasterising needs a canvas, which workerd has
  none of). Updated.
* `adminOrders.test.ts`'s oversell test assumed two baskets for scarce stock
  could both be *created* and would collide at delivery. Stock reservation moved
  that refusal forward to order creation. The test now asserts the same
  invariant — the canteen never promises more portions than it has — at the
  point the system now enforces it.

---

## CI

`.github/workflows/ci.yml` runs typecheck (`src` and `tests`), lint if a lint
script exists, and the full suite against an **ephemeral Postgres service
container** plus a `wsproxy` sidecar. There is no database secret in the
workflow, and there cannot usefully be one: the guard refuses any URL that is
not a disposable test database.
