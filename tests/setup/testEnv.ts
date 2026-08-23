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

  return { hasDatabase: true, reason: "", databaseUrl: candidate, target };
}
