/**
 * One-off repair: zero every CollectionWindow.bookedCount.
 *
 * bookedCount is a denormalised counter maintained alongside Order rows. After
 * the order table was cleared wholesale, the counters kept pointing at orders
 * that no longer exist — one window read 1/1, i.e. full, and would have
 * refused new bookings for slots nobody actually held.
 *
 * Safe to re-run: it only touches rows already out of step, and reports what
 * it changed. If real orders exist, this is NOT the right tool — the counter
 * would then be legitimately non-zero, so it refuses to run in that case
 * rather than quietly corrupting live bookings.
 */
import "dotenv/config";
import { Pool } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set (expected in backend/.env).");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  const { rows: orderRows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "Order"',
  );
  const orderCount = orderRows[0]?.n ?? 0;
  if (orderCount > 0) {
    console.error(
      `Refusing to run: ${orderCount} orders exist, so bookedCount may be legitimate. ` +
        "This script is only for repairing counters left behind by a full order wipe.",
    );
    process.exit(1);
  }

  const { rows: before } = await pool.query<{
    startAt: string;
    kitchen: string;
    capacity: number;
    bookedCount: number;
  }>('SELECT "startAt", "kitchen", "capacity", "bookedCount" FROM "CollectionWindow" WHERE "bookedCount" <> 0 ORDER BY "startAt"');

  if (before.length === 0) {
    console.log("Nothing to do — every window already reads zero.");
  } else {
    for (const w of before) {
      console.log(`  ${w.startAt} ${w.kitchen}: ${w.bookedCount}/${w.capacity} -> 0/${w.capacity}`);
    }
    const { rowCount } = await pool.query(
      'UPDATE "CollectionWindow" SET "bookedCount" = 0 WHERE "bookedCount" <> 0',
    );
    console.log(`Reset ${rowCount} window(s).`);
  }

  const { rows: after } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "CollectionWindow" WHERE "bookedCount" <> 0',
  );
  console.log(`Windows still non-zero: ${after[0]?.n ?? 0}`);
} finally {
  await pool.end();
}
