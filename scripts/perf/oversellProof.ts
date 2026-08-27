// Proof that the reservation ceiling holds: drive one item's sellable stock to
// a small number, fire more concurrent orders than that, and show the excess
// is rejected cleanly instead of accepted.
//
// The item's stockQty is snapshotted and restored in a finally block.
import "dotenv/config";
import { getPool } from "../../src/lib/db.js";
import { query, sql } from "../../src/db/sql.js";
import type { MenuItem } from "../../src/db/schema.js";
import {
  createOrder,
  cancelOrder,
  releaseExpiredReservations,
  reconcileReservations,
} from "../../src/services/orderService.js";

const pool = getPool(process.env.DATABASE_URL!);
const SELLABLE = Number(process.env.PROOF_SELLABLE ?? 5);
const ATTEMPTS = Number(process.env.PROOF_ATTEMPTS ?? 20);

async function fetchItem(id: string): Promise<MenuItem> {
  const { rows } = await query<MenuItem>(pool, sql`SELECT * FROM "MenuItem" WHERE "id" = ${id}::text LIMIT 1`);
  if (rows.length === 0) throw new Error(`MenuItem ${id} not found`);
  return rows[0];
}

const { rows: students } = await query<{ id: string }>(
  pool,
  sql`SELECT "id" FROM "User" WHERE "role" = 'STUDENT'::"Role" AND "isActive" = true LIMIT ${ATTEMPTS}`,
);

const { rows: itemRows } = await query<MenuItem>(
  pool,
  sql`SELECT * FROM "MenuItem" WHERE "isAvailable" = true ORDER BY "name" ASC LIMIT 1`,
);
if (itemRows.length === 0) throw new Error("No available menu item found to run the proof against");
const item = itemRows[0];
const original = { stockQty: item.stockQty, reservedQty: item.reservedQty };
console.log(`item "${item.name}" original stockQty=${original.stockQty} reservedQty=${original.reservedQty}`);

const createdIds: string[] = [];
try {
  // Sellable = stockQty - reservedQty. Pin it to exactly SELLABLE.
  await query(pool, sql`UPDATE "MenuItem" SET "stockQty" = ${original.reservedQty + SELLABLE} WHERE "id" = ${item.id}::text`);
  console.log(`\npinned sellable stock to ${SELLABLE}; firing ${ATTEMPTS} concurrent orders of qty 1\n`);

  const results = await Promise.allSettled(
    students.map((s) =>
      createOrder(pool, { owner: { studentId: s.id }, items: [{ menuItemId: item.id, qty: 1 }] }),
    ),
  );

  const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  for (const r of ok) createdIds.push(...r.value.map((o: any) => o.id));

  const codes: Record<string, number> = {};
  for (const f of failed) {
    const key = `${f.reason?.status ?? "?"} ${f.reason?.code ?? f.reason?.name ?? "?"}`;
    codes[key] = (codes[key] ?? 0) + 1;
  }

  const after = await fetchItem(item.id);
  console.log(`accepted   ${ok.length}   (expected ${SELLABLE})`);
  console.log(`rejected   ${failed.length}   ${JSON.stringify(codes)}`);
  console.log(`sample rejection: ${failed[0]?.reason?.message}`);
  console.log(`stockQty ${after.stockQty} reservedQty ${after.reservedQty}  sellable ${after.stockQty - after.reservedQty}`);
  console.log(`OVERSOLD? ${ok.length > SELLABLE ? "YES — BROKEN" : "NO"}`);
  console.log(`sellable never negative? ${after.stockQty - after.reservedQty >= 0 ? "yes" : "NO — BROKEN"}`);

  // ---- release on cancel -------------------------------------------------
  console.log(`\ncancelling ${createdIds.length} orders…`);
  for (const id of createdIds) await cancelOrder(pool, id);
  // cancel twice on the first one: release must be idempotent
  if (createdIds[0]) await cancelOrder(pool, createdIds[0]);
  const afterCancel = await fetchItem(item.id);
  console.log(`after cancel (incl. one double-cancel): reservedQty ${afterCancel.reservedQty} (expected ${original.reservedQty})`);

  // ---- release on expiry -------------------------------------------------
  const [expiring] = await createOrder(pool, {
    owner: { studentId: students[0].id },
    items: [{ menuItemId: item.id, qty: 1 }],
  });
  createdIds.push(expiring.id);
  const held = await fetchItem(item.id);
  await query(
    pool,
    sql`UPDATE "Order" SET "reservationExpiresAt" = ${new Date(Date.now() - 60_000).toISOString()}::timestamp WHERE "id" = ${expiring.id}::text`,
  );
  const swept = await releaseExpiredReservations(pool);
  const afterExpiry = await fetchItem(item.id);
  console.log(`\nexpiry: reservedQty ${held.reservedQty} -> ${afterExpiry.reservedQty} after sweeping ${swept} expired order(s)`);

  // ---- reconcile heals a stranded claim ----------------------------------
  await query(pool, sql`UPDATE "MenuItem" SET "reservedQty" = ${afterExpiry.reservedQty + 7} WHERE "id" = ${item.id}::text`);
  const healed = await reconcileReservations(pool);
  const afterReconcile = await fetchItem(item.id);
  console.log(`reconcile: injected +7 stranded reservation, rebuild touched ${healed} item(s), reservedQty now ${afterReconcile.reservedQty} (expected ${afterExpiry.reservedQty})`);
} finally {
  await query(pool, sql`UPDATE "MenuItem" SET "stockQty" = ${original.stockQty} WHERE "id" = ${item.id}::text`);
  const restored = await fetchItem(item.id);
  console.log(`\nrestored "${item.name}" stockQty=${restored.stockQty} (was ${original.stockQty}) reservedQty=${restored.reservedQty}`);
  await pool.end();
}
process.exit(0);
