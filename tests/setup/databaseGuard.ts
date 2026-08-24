/**
 * THE GUARD.
 *
 * This module exists because running `npm test` against the shared live Neon
 * database once destroyed real data: the suite's `deleteMany()` cleanup hooks
 * wiped three admin accounts, a student account and the whole menu, mid-day,
 * because `DATABASE_URL` was read out of `.env`.
 *
 * The rule this file enforces is mechanical, not a convention and not a
 * comment: the test suite may only ever open a connection to a database that
 * has *proved* it is a throwaway test database. Proof is layered, and every
 * layer must pass:
 *
 *   1. STATIC   — the connection string itself must look like a test target:
 *                 a local/CI host, a database name containing "test", and it
 *                 must not be the URL any `.env*` file in the repo points at.
 *   2. OPT-IN   — a remote (non-local) target additionally requires an
 *                 explicit `ALLOW_REMOTE_TEST_DATABASE=1`, so pointing at a
 *                 Neon *branch* is possible but never accidental.
 *   3. RUNTIME  — the database must physically contain the marker table
 *                 `_klh_test_database`. That table is only ever created by
 *                 this suite, and only into a database that is completely
 *                 empty of users and orders. The live database has 154 users
 *                 and 191 orders, so it can never acquire the marker, and
 *                 therefore can never pass this check — even if someone
 *                 defeats every string check above.
 *
 * Nothing in tests/ may construct a PrismaClient except through
 * tests/helpers/db.ts, which refuses to hand one out until this module has
 * signed off. Failure is a thrown error with a banner, never a warning and
 * never a silent fall-through.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Hosts that cannot be anything but a developer machine or a CI runner. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
  // Service-container hostnames used by docker compose / GitHub Actions.
  "postgres",
  "postgres-test",
  "db",
]);

/**
 * Env files that describe a REAL database. Any URL found in one of these is
 * permanently forbidden as a test target, whatever else it looks like.
 * `.env.test` is deliberately absent from this list.
 */
const LIVE_ENV_FILES = [".env", ".env.local", ".env.production", ".env.development"];

/** A database name has to say it is a test database. */
const TEST_DB_NAME = /(^|[-_])tests?([-_]|$)/i;

export class TestDatabaseGuardError extends Error {
  constructor(reason: string, url: string | undefined, hint: string) {
    super(banner(reason, url, hint));
    this.name = "TestDatabaseGuardError";
  }
}

function redact(url: string | undefined): string {
  if (!url) return "(unset)";
  return url.replace(/(:\/\/[^:/@]*:)[^@]*@/, "$1********@");
}

function banner(reason: string, url: string | undefined, hint: string): string {
  return [
    "",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "!!  REFUSING TO RUN TESTS — UNSAFE DATABASE TARGET                       !!",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "",
    `  reason : ${reason}`,
    `  target : ${redact(url)}`,
    "",
    "  The test suite deletes every row in User, Order, OrderItem, MenuItem and",
    "  Category. It is only ever allowed to do that to a disposable database.",
    "",
    `  ${hint}`,
    "",
    "  See TESTING.md.",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "",
  ].join("\n");
}

export interface ParsedTarget {
  host: string;
  port: string;
  database: string;
  user: string;
  isLocal: boolean;
}

export function parseTarget(url: string): ParsedTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TestDatabaseGuardError(
      "DATABASE_URL is not a parseable URL",
      url,
      "Fix DATABASE_URL in .env.test.",
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new TestDatabaseGuardError(
      `DATABASE_URL protocol is "${parsed.protocol}", expected postgresql:`,
      url,
      "Fix DATABASE_URL in .env.test.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  return {
    host,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    user: decodeURIComponent(parsed.username),
    isLocal: LOCAL_HOSTS.has(host),
  };
}

/** Identity of a database, ignoring credentials and query parameters. */
function identity(url: string): string | null {
  try {
    const t = parseTarget(url);
    return `${t.host}:${t.port}/${t.database}`;
  } catch {
    return null;
  }
}

/** Every DATABASE_URL mentioned by a non-test env file in the repo. */
export function readLiveDatabaseUrls(root = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const file of LIVE_ENV_FILES) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      found.push(match[1]!.replace(/^["']|["']$/g, ""));
    }
  }
  return found;
}

/**
 * The static half of the guard. Pure, synchronous, and total: it either
 * returns the parsed target or throws. Called before anything opens a socket.
 */
export function assertSafeTestDatabaseUrl(
  url: string | undefined,
  options: { allowRemote?: boolean; liveUrls?: string[] } = {},
): ParsedTarget {
  if (!url || !url.trim()) {
    throw new TestDatabaseGuardError(
      "DATABASE_URL is not set",
      url,
      "Create .env.test (see .env.test.example) and run `npm run test:db:up`.",
    );
  }

  const target = parseTarget(url);
  const liveUrls = options.liveUrls ?? readLiveDatabaseUrls();
  const targetIdentity = identity(url);

  // 1. Never, under any circumstances, the database a real env file points at.
  for (const liveUrl of liveUrls) {
    if (identity(liveUrl) && identity(liveUrl) === targetIdentity) {
      throw new TestDatabaseGuardError(
        "DATABASE_URL is the SAME DATABASE that .env points at — this is the live database",
        url,
        "Point DATABASE_URL at a throwaway database in .env.test. Never at the one in .env.",
      );
    }
  }

  // 2. The database name has to say it is a test database.
  if (!TEST_DB_NAME.test(target.database)) {
    throw new TestDatabaseGuardError(
      `database name "${target.database}" does not contain "test"`,
      url,
      'Name the test database something like "klh_canteen_test".',
    );
  }

  // 3. Remote targets are possible (a Neon branch) but never implicit.
  if (!target.isLocal && !options.allowRemote) {
    throw new TestDatabaseGuardError(
      `host "${target.host}" is not a local or CI host`,
      url,
      "Use `npm run test:db:up` for a local Postgres, or — if you really mean a dedicated Neon branch — set ALLOW_REMOTE_TEST_DATABASE=1 in .env.test after triple-checking the branch.",
    );
  }

  return target;
}
