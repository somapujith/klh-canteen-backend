/**
 * The runtime half of the guard: a physical marker inside the database.
 *
 * Every string check in databaseGuard.ts inspects a URL. This one inspects the
 * database itself, which is what makes the guard hard to defeat by accident:
 *
 *   - `klh_test_guard.marker` is created by this suite and by nothing else.
 *   - It is only ever created into a database that contains ZERO users and
 *     ZERO orders — i.e. one that has just been migrated and never used.
 *   - The live database has 154 users and 191 orders, so it can never be
 *     given the marker, and therefore can never pass verification. Even a
 *     connection string crafted to satisfy every static rule stops here.
 *
 * Nothing in the suite is allowed to delete a row until this has passed.
 */
import { Pool } from "@neondatabase/serverless";
import { TestDatabaseGuardError } from "./databaseGuard.js";

/**
 * The marker lives in its OWN schema, not in `public`.
 *
 * `prisma db push` (which the bootstrap runs to reconcile the migration drift
 * described in TESTING.md) manages the `public` schema and drops anything it
 * does not know about — including, on the first attempt at this, the marker
 * itself. A separate schema is outside Prisma's remit, so the database's claim
 * survives every schema operation the suite performs on it.
 */
export const MARKER_SCHEMA = "klh_test_guard";
export const MARKER_TABLE = "marker";
export const MARKER_QUALIFIED = `${MARKER_SCHEMA}.${MARKER_TABLE}`;

async function withPool<T>(url: string, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function markerExists(pool: Pool): Promise<boolean> {
  const res = await pool.query(`SELECT to_regclass('${MARKER_QUALIFIED}') AS t`);
  return res.rows[0]?.t !== null && res.rows[0]?.t !== undefined;
}

/**
 * Creates the marker, but only into a database that is provably unused.
 * Called once per run from globalSetup, after the static guard has passed.
 */
export async function ensureTestDatabaseMarker(url: string): Promise<void> {
  await withPool(url, async (pool) => {
    if (await markerExists(pool)) return;

    // A database that already holds users or orders is somebody's real data,
    // whatever its name says. Refuse to adopt it.
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "Order") AS orders`,
    );
    const users = Number(counts.rows[0].users);
    const orders = Number(counts.rows[0].orders);

    if (users > 0 || orders > 0) {
      throw new TestDatabaseGuardError(
        `database already contains real data (${users} users, ${orders} orders) and has no test marker`,
        url,
        "This looks like a database somebody is using. Point DATABASE_URL at an empty, disposable database — `npm run test:db:reset` makes one.",
      );
    }

    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${MARKER_SCHEMA}"`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${MARKER_SCHEMA}"."${MARKER_TABLE}" (
         id            integer PRIMARY KEY DEFAULT 1,
         claimed_at    timestamptz NOT NULL DEFAULT now(),
         note          text NOT NULL
       )`,
    );
    await pool.query(
      `INSERT INTO "${MARKER_SCHEMA}"."${MARKER_TABLE}" (id, note) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [
        "Claimed by the KLH canteen test suite. Its presence is what permits " +
          "destructive test cleanup. Never create this table in a real database.",
      ],
    );
  });
}

/**
 * Re-checked in every worker, before any test file's hooks can run. Cheap
 * (one catalogue lookup) and deliberately not cached across processes.
 */
export async function verifyTestDatabaseMarker(url: string): Promise<void> {
  const present = await withPool(url, markerExists);
  if (!present) {
    throw new TestDatabaseGuardError(
      `database has no "${MARKER_QUALIFIED}" marker table`,
      url,
      "Only a database claimed by the test suite may be wiped. Run `npm run test:db:reset`.",
    );
  }
}
