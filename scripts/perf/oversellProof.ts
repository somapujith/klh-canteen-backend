// Proof that the reservation ceiling holds: drive one item's sellable stock to
// a small number, fire more concurrent orders than that, and show the excess
// is rejected cleanly instead of accepted.
//
// The item's stockQty is snapshotted and restored in a finally block.
import "dotenv/config";
import { getPrisma } from "../../src/lib/prisma.js";
import {
  createOrder,
  cancelOrder,
  releaseExpiredReservations,
  reconcileReservations,
} from "../../src/services/orderService.js";

const prisma = getPrisma(process.env.DATABASE_URL!);
const SELLABLE = Number(process.env.PROOF_SELLABLE ?? 5);
const ATTEMPTS = Number(process.env.PROOF_ATTEMPTS ?? 20);
const secret = process.env.QR_TOKEN_SECRET!;

const students = await prisma.user.findMany({ where: { role: "STUDENT", isActive: true }, take: ATTEMPTS });
const item = await prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true }, orderBy: { name: "asc" } });
const original = { stockQty: item.stockQty, reservedQty: item.reservedQty };
console.log(`item "${item.name}" original stockQty=${original.stockQty} reservedQty=${original.reservedQty}`);

const createdIds: string[] = [];
try {
  // Sellable = stockQty - reservedQty. Pin it to exactly SELLABLE.
  await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: original.reservedQty + SELLABLE } });
  console.log(`\npinned sellable stock to ${SELLABLE}; firing ${ATTEMPTS} concurrent orders of qty 1\n`);

  const results = await Promise.allSettled(
    students.map((s) =>
      createOrder(prisma, secret, { owner: { studentId: s.id }, items: [{ menuItemId: item.id, qty: 1 }] }),
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

  const after = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`accepted   ${ok.length}   (expected ${SELLABLE})`);
  console.log(`rejected   ${failed.length}   ${JSON.stringify(codes)}`);
  console.log(`sample rejection: ${failed[0]?.reason?.message}`);
  console.log(`stockQty ${after.stockQty} reservedQty ${after.reservedQty}  sellable ${after.stockQty - after.reservedQty}`);
  console.log(`OVERSOLD? ${ok.length > SELLABLE ? "YES — BROKEN" : "NO"}`);
  console.log(`sellable never negative? ${after.stockQty - after.reservedQty >= 0 ? "yes" : "NO — BROKEN"}`);

  // ---- release on cancel -------------------------------------------------
  console.log(`\ncancelling ${createdIds.length} orders…`);
  for (const id of createdIds) await cancelOrder(prisma, id);
  // cancel twice on the first one: release must be idempotent
  if (createdIds[0]) await cancelOrder(prisma, createdIds[0]);
  const afterCancel = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`after cancel (incl. one double-cancel): reservedQty ${afterCancel.reservedQty} (expected ${original.reservedQty})`);

  // ---- release on expiry -------------------------------------------------
  const [expiring] = await createOrder(prisma, secret, {
    owner: { studentId: students[0].id },
    items: [{ menuItemId: item.id, qty: 1 }],
  });
  createdIds.push(expiring.id);
  const held = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  await prisma.order.update({ where: { id: expiring.id }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
  const swept = await releaseExpiredReservations(prisma);
  const afterExpiry = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`\nexpiry: reservedQty ${held.reservedQty} -> ${afterExpiry.reservedQty} after sweeping ${swept} expired order(s)`);

  // ---- reconcile heals a stranded claim ----------------------------------
  await prisma.menuItem.update({ where: { id: item.id }, data: { reservedQty: afterExpiry.reservedQty + 7 } });
  const healed = await reconcileReservations(prisma);
  const afterReconcile = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`reconcile: injected +7 stranded reservation, rebuild touched ${healed} item(s), reservedQty now ${afterReconcile.reservedQty} (expected ${afterExpiry.reservedQty})`);
} finally {
  await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: original.stockQty } });
  const restored = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`\nrestored "${item.name}" stockQty=${restored.stockQty} (was ${original.stockQty}) reservedQty=${restored.reservedQty}`);
}
process.exit(0);
