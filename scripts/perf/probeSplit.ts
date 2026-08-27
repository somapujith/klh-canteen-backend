// Exercises the two paths the fast create() has to keep working: a cart that
// spans both kitchens, and a pre-booked cart that must win a window seat.
import "dotenv/config";
import crypto from "node:crypto";
import { getPool } from "../../src/lib/db.js";
import { query, sql } from "../../src/db/sql.js";
import type { MenuItem, CollectionWindow } from "../../src/db/schema.js";
import { createOrder, cancelOrder, normaliseCollectionSlot } from "../../src/services/orderService.js";

const pool = getPool(process.env.DATABASE_URL!);

const { rows: studentRows } = await query<{ id: string }>(
  pool,
  sql`SELECT "id" FROM "User" WHERE "role" = 'STUDENT'::"Role" AND "isActive" = true LIMIT 1`,
);
if (studentRows.length === 0) throw new Error("No active student found to run the probe against");
const student = studentRows[0];

async function firstMenuItem(kitchen: string): Promise<MenuItem> {
  const { rows } = await query<MenuItem>(
    pool,
    sql`
      SELECT mi.* FROM "MenuItem" mi
      JOIN "Category" c ON c."id" = mi."categoryId"
     WHERE mi."isAvailable" = true AND c."kitchen" = ${kitchen}::"Kitchen"
     LIMIT 1
    `,
  );
  if (rows.length === 0) throw new Error(`No available ${kitchen} menu item found`);
  return rows[0];
}

const snack = await firstMenuItem("SNACKS");
const meal = await firstMenuItem("MEALS");
const items = [{ menuItemId: snack.id, qty: 1 }, { menuItemId: meal.id, qty: 1 }];
const cleanup: string[] = [];

const split = await createOrder(pool, { owner: { studentId: student.id }, items });
cleanup.push(...split.map((o) => o.id));
console.log("cross-kitchen cart ->", split.map((o) => `${o.kitchen}#${o.orderNumber} total=${o.totalAmount} items=${o.items.length} student=${o.student?.name}`).join("  |  "));

const slot = normaliseCollectionSlot(new Date(Date.now() + 90 * 60 * 1000));
const booked = await createOrder(pool, { owner: { studentId: student.id }, items, collectionAt: slot });
cleanup.push(...booked.map((o) => o.id));
console.log("pre-booked cart   ->", booked.map((o) => `${o.kitchen}#${o.orderNumber} collectionAt=${o.collectionAt?.toISOString()}`).join("  |  "));
const { rows: windows } = await query<CollectionWindow>(
  pool,
  sql`SELECT * FROM "CollectionWindow" WHERE "startAt" = ${slot.toISOString()}::timestamp`,
);
console.log("window ledger     ->", windows.map((w) => `${w.kitchen} ${w.bookedCount}/${w.capacity}`).join("  |  "));

// Duplicate line items in one cart must collapse into a single claim.
const dup = await createOrder(pool, {
  owner: { studentId: student.id },
  items: [{ menuItemId: snack.id, qty: 2 }, { menuItemId: snack.id, qty: 3 }],
});
cleanup.push(...dup.map((o) => o.id));
console.log("duplicate lines   ->", dup.map((o) => `#${o.orderNumber} lines=${o.items.length} qty=${o.items.map((i) => i.quantity).join("+")} total=${o.totalAmount}`).join(""));

// Guest ownership still works off the same path.
const guest = await createOrder(pool, {
  owner: { guestSessionId: "probe-" + crypto.randomUUID(), guestName: "Probe Guest", guestPhone: "0000000000" },
  items: [{ menuItemId: snack.id, qty: 1 }],
});
cleanup.push(...guest.map((o) => o.id));
console.log("guest cart        ->", guest.map((o) => `#${o.orderNumber} student=${o.student} guestName=${o.guestName}`).join(""));

for (const id of cleanup) await cancelOrder(pool, id);
const { rows: after } = await query<{ name: string; stockQty: number; reservedQty: number }>(
  pool,
  sql`SELECT "name", "stockQty", "reservedQty" FROM "MenuItem" WHERE "id" = ANY(${[snack.id, meal.id]}::text[])`,
);
console.log("after cancelling all probe orders ->", JSON.stringify(after));
await pool.end();
process.exit(0);
