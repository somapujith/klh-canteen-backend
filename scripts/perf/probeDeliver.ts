// Exercises the admin side: PENDING -> ... -> DELIVERED must turn the
// reservation into a real stock decrement exactly once, and must still refuse
// to deliver an order whose physical stock has been taken away underneath it.
import "dotenv/config";
import { getPool } from "../../src/lib/db.js";
import { query, sql } from "../../src/db/sql.js";
import type { MenuItem, Order } from "../../src/db/schema.js";
import { createOrder, updateOrderStatus, releaseExpiredReservations } from "../../src/services/orderService.js";

const pool = getPool(process.env.DATABASE_URL!);

const { rows: studentRows } = await query<{ id: string }>(
  pool,
  sql`SELECT "id" FROM "User" WHERE "role" = 'STUDENT'::"Role" AND "isActive" = true LIMIT 1`,
);
if (studentRows.length === 0) throw new Error("No active student found to run the probe against");
const student = studentRows[0];

const { rows: itemRows } = await query<MenuItem>(
  pool,
  sql`
    SELECT mi.* FROM "MenuItem" mi
    JOIN "Category" c ON c."id" = mi."categoryId"
   WHERE mi."isAvailable" = true AND c."kitchen" = 'SNACKS'::"Kitchen"
   LIMIT 1
  `,
);
if (itemRows.length === 0) throw new Error("No available SNACKS menu item found to run the probe against");
const item = itemRows[0];
const before = { stockQty: item.stockQty, reservedQty: item.reservedQty };
console.log(`item "${item.name}" before: stock=${before.stockQty} reserved=${before.reservedQty}`);

async function fetchItem(): Promise<MenuItem> {
  const { rows } = await query<MenuItem>(pool, sql`SELECT * FROM "MenuItem" WHERE "id" = ${item.id}::text LIMIT 1`);
  return rows[0];
}

async function fetchOrder(id: string): Promise<Order> {
  const { rows } = await query<Order>(pool, sql`SELECT * FROM "Order" WHERE "id" = ${id}::text LIMIT 1`);
  if (rows.length === 0) throw new Error(`Order ${id} not found`);
  return rows[0];
}

const snap = async (label: string) => {
  const m = await fetchItem();
  console.log(`  ${label}: stock=${m.stockQty} reserved=${m.reservedQty}`);
  return m;
};

try {
  // --- happy path ---------------------------------------------------------
  const [order] = await createOrder(pool, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 2 }] });
  await snap("after order (stock untouched, 2 reserved)");
  // PREPARING is retired as an inbound transition — the board's flow is now
  // PENDING -> COOKED -> DELIVERED (see orderService.ts's NEXT_STATUS).
  for (const status of ["COOKED", "DELIVERED"]) {
    const r = await updateOrderStatus(pool, order.id, status);
    console.log(`  -> ${r.status}`);
  }
  const delivered = await snap("after DELIVERED (stock -2, reservation returned)");
  console.log(`  net stock change: ${delivered.stockQty - before.stockQty} (expected -2); reserved back to ${delivered.reservedQty} (expected ${before.reservedQty})`);

  // --- reservation already released by the sweeper, then delivered anyway --
  const [late] = await createOrder(pool, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 1 }] });
  await query(
    pool,
    sql`UPDATE "Order" SET "reservationExpiresAt" = ${new Date(Date.now() - 60_000).toISOString()}::timestamp WHERE "id" = ${late.id}::text`,
  );
  await releaseExpiredReservations(pool);
  const afterSweep = await snap("expired reservation swept");
  for (const status of ["COOKED", "DELIVERED"]) await updateOrderStatus(pool, late.id, status);
  const afterLate = await snap("swept order delivered anyway");
  console.log(`  stock -1 exactly? ${afterLate.stockQty === afterSweep.stockQty - 1}; reserved not double-credited? ${afterLate.reservedQty === afterSweep.reservedQty}`);

  // --- physical stock pulled from under a placed order --------------------
  const [starved] = await createOrder(pool, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 1 }] });
  const held = await fetchItem();
  await query(pool, sql`UPDATE "MenuItem" SET "stockQty" = 0 WHERE "id" = ${item.id}::text`);
  for (const status of ["COOKED"]) await updateOrderStatus(pool, starved.id, status);
  try {
    await updateOrderStatus(pool, starved.id, "DELIVERED");
    console.log("  DELIVERED accepted — EXPECTED A REJECTION");
  } catch (err: any) {
    console.log(`  DELIVERED rejected: ${err.status} ${err.code} — ${err.message}`);
  }
  const rolled = await fetchOrder(starved.id);
  const rolledItem = await fetchItem();
  console.log(`  order left at ${rolled.status}; settle rolled back? ${rolled.stockSettledAt === null}; reserved untouched? ${rolledItem.reservedQty === held.reservedQty}`);
  await query(pool, sql`UPDATE "MenuItem" SET "stockQty" = ${held.stockQty} WHERE "id" = ${item.id}::text`);
} finally {
  const end = await fetchItem();
  console.log(`\nfinal: stock=${end.stockQty} reserved=${end.reservedQty} (started stock=${before.stockQty} reserved=${before.reservedQty}; 3 portions genuinely delivered/held)`);
  await pool.end();
}
process.exit(0);
