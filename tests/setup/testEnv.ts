/**
 * Environment resolution for the test suite.
 *
 * THE ONE RULE: the suite never reads `DATABASE_URL` out of the ambient
 * environment. `.env` — the file that points at the shared live Neon database
 * — is not loaded here, and any `DATABASE_URL` inherited from the shell is
 * discarded before anything can use it. A test database has to be named
 * somewhere that only ever describes a test database:
 *
 *   1. `TEST_DATABASE_URL`  — explicit, used by CI. Cannot be inherited from
 *                             `.env` because nothing else in this repo ever
 *                             sets that name.
 *   2. `.env.test`          — the local developer path. Loaded with
 *                             override:true so a stale shell variable cannot
 *                             win.
 *
 * If neither is present the suite runs with NO database at all and the
 * database-backed tests skip loudly. It never falls back.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { neonConfig } from "@neondatabase/serverless";
import { assertSafeTestDatabaseUrl, REPO_ROOT, type ParsedTarget } from "./databaseGuard.js";

export interface TestEnv {
  /** True when a validated, safe test database is configured. */
  hasDatabase: boolean;
  /** Human-readable explanation shown when hasDatabase is false. */
  reason: string;
  databaseUrl?: string;
  target?: ParsedTarget;
}

const ENV_TEST_FILE = path.join(REPO_ROOT, ".env.test");

let memo: TestEnv | undefined;

export function resolveTestEnv(): TestEnv {
  if (memo) return memo;
  memo = compute();
  return memo;
}

function compute(): TestEnv {
  // Anything the shell (or a previously sourced .env) put here is untrusted
  // and is dropped before a single line of test code can read it.
  const inherited = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const explicit = process.env.TEST_DATABASE_URL?.trim();

  let fromFile: string | undefined;
  if (existsSync(ENV_TEST_FILE)) {
    // override:true: .env.test is the authority for a test run.
    const parsed = loadDotenv({ path: ENV_TEST_FILE, override: true });
    fromFile = parsed.parsed?.DATABASE_URL?.trim();
    // dotenv just wrote DATABASE_URL back into process.env; keep it only if we
    // end up accepting it below.
    delete process.env.DATABASE_URL;
  }

  // Test-only fallbacks so the pure/unit tests can run on a bare checkout.
  process.env.JWT_SECRET ||= "test-jwt-secret-do-not-use-anywhere-real";
  process.env.QR_TOKEN_SECRET ||= "test-qr-secret-do-not-use-anywhere-real";
  process.env.CORS_ORIGIN ||= "*";

  const candidate = explicit || fromFile;

  if (!candidate) {
    return {
      hasDatabase: false,
      reason: inherited
        ? "No test database configured. (A DATABASE_URL was inherited from the environment and was DISCARDED — the suite never uses it.) Run `npm run test:db:up`, or copy .env.test.example to .env.test."
        : "No test database configured. Run `npm run test:db:up`, or copy .env.test.example to .env.test.",
    };
  }

  // Throws — loudly — if the candidate is anything but a disposable database.
  const target = assertSafeTestDatabaseUrl(candidate, {
    allowRemote: process.env.ALLOW_REMOTE_TEST_DATABASE === "1",
  });

  // Only now does the app-visible variable get set, and only to the value the
  // guard approved. src/lib/context.ts reads this via hono/adapter's env().
  process.env.DATABASE_URL = candidate;

  configureNeonForLocalPostgres(target);

  return { hasDatabase: true, reason: "", databaseUrl: candidate, target };
}

/**
 * Points @neondatabase/serverless at a local Postgres.
 *
 * The driver talks WebSockets to Neon's endpoint, not the raw Postgres wire
 * protocol, so a plain `postgres:16` container is unreachable to it: the
 * connection fails with an opaque ErrorEvent rather than a refusal that names
 * a cause. `neondatabase/wsproxy` bridges the two, and these three settings
 * are what redirect the driver to it:
 *
 *   - `wsProxy`             where to open the WebSocket
 *   - `useSecureWebSocket`  false — the local proxy is ws://, not wss://
 *   - `pipelineConnect`     disabled — that optimisation assumes Neon's own
 *                           auth handshake, which the proxy does not perform
 *
 * Applied only for a local target. A remote Neon branch (the CI path, and the
 * `ALLOW_REMOTE_TEST_DATABASE=1` path) speaks the real protocol and must be
 * left alone entirely.
 */
function configureNeonForLocalPostgres(target: ParsedTarget): void {
  if (!target.isLocal) return;

  const proxyPort = process.env.TEST_WS_PROXY_PORT?.trim() || "55434";
  // The proxy fronts the database, so the driver connects to IT rather than to
  // Postgres' own port — and it needs telling, via ?address=, which backend to
  // open on the far side. Without that parameter wsproxy logs `allowed=false`
  // and closes the socket, which surfaces as a bare ErrorEvent with no cause.
  //
  // The ?address= is resolved INSIDE the proxy container, so it must name the
  // database as that container sees it — the Docker service name and its
  // internal port — not the host-published localhost:55433, which inside the
  // container resolves to the proxy itself and is refused.
  //
  // The wsproxy container must also run with ALLOW_ADDR_REGEX='.*'; it
  // otherwise permits only *.neon.tech:5432 and rejects a local backend with
  // `allowed=false`, surfacing as a bare ErrorEvent with no cause.
  const backend = process.env.TEST_WS_PROXY_BACKEND?.trim() || "klh-testdb:5432";
  neonConfig.wsProxy = () => `localhost:${proxyPort}/v1?address=${backend}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  // Node does not expose a global WebSocket in every supported version, so the
  // driver is handed one explicitly rather than left to discover one.
  neonConfig.webSocketConstructor = WebSocket;
}
