/**
 * The ONLY door to the database from a test.
 *
 * Nothing under tests/ may call getPool() itself. Everything goes through
 * here, and here refuses to do anything until tests/setup/vitest.setup.ts has
 * verified the target (see tests/setup/databaseGuard.ts and marker.ts).
 */
import { describe } from "vitest";
import type { Pool } from "@neondatabase/serverless";
import { getPool } from "../../src/lib/db.js";
import { resolveTestEnv } from "../setup/testEnv.js";
import { assertGuardVerified } from "../setup/guardState.js";

const env = resolveTestEnv();

export const testDb = {
  enabled: env.hasDatabase,
  reason: env.reason,
  url: env.databaseUrl,
};

/**
 * `describeDb("...", () => {...})` runs the block only when a verified test
 * database is available, and otherwise skips it with the reason printed —
 * rather than silently passing, and rather than falling through to `.env`.
 */
export const describeDb: typeof describe | typeof describe.skip = testDb.enabled
  ? describe
  : (((name: string, fn: () => void) => {
      describe.skip(`${name} [SKIPPED: ${testDb.reason}]`, fn);
    }) as typeof describe);

let pool: Pool | undefined;

export function getTestPool(): Pool {
  assertGuardVerified();
  if (!pool) pool = getPool(testDb.url!);
  return pool;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}

/**
 * Wipes every application table.
 *
 * TRUNCATE over the live table catalogue rather than a hand-maintained list of
 * `deleteMany()` calls: the schema is actively changing (stock reservations,
 * cohorts, audit logs all arrived recently) and a hardcoded list silently
 * stops cleaning newly added tables, which shows up later as cross-test
 * pollution. CASCADE also spares us from having to know the FK order.
 *
 * `_migrations` is the one exclusion. The guard marker needs none: it lives
 * in its own schema (klh_test_guard), outside `public` entirely.
 */
export async function resetDatabase(): Promise<void> {
  assertGuardVerified();
  const db = getTestPool();

  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('_migrations')`,
  );
  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
