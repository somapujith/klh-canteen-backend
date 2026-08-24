// Exercises the admin side: PENDING -> ... -> DELIVERED must turn the
// reservation into a real stock decrement exactly once, and must still refuse
// to deliver an order whose physical stock has been taken away underneath it.
import "dotenv/config";
import { getPrisma } from "../../src/lib/prisma.js";
import { createOrder, updateOrderStatus, releaseExpiredReservations } from "../../src/services/orderService.js";

const prisma = getPrisma(process.env.DATABASE_URL!);
const secret = process.env.QR_TOKEN_SECRET!;
const student = await prisma.user.findFirstOrThrow({ where: { role: "STUDENT", isActive: true } });
const item = await prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, category: { kitchen: "SNACKS" } } });
const before = { stockQty: item.stockQty, reservedQty: item.reservedQty };
console.log(`item "${item.name}" before: stock=${before.stockQty} reserved=${before.reservedQty}`);

const snap = async (label: string) => {
  const m = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`  ${label}: stock=${m.stockQty} reserved=${m.reservedQty}`);
  return m;
};

try {
  // --- happy path ---------------------------------------------------------
  const [order] = await createOrder(prisma, secret, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 2 }] });
  await snap("after order (stock untouched, 2 reserved)");
  for (const status of ["PREPARING", "COOKED", "DELIVERED"]) {
    const r = await updateOrderStatus(prisma, order.id, status);
    console.log(`  -> ${r.status}`);
  }
  const delivered = await snap("after DELIVERED (stock -2, reservation returned)");
  console.log(`  net stock change: ${delivered.stockQty - before.stockQty} (expected -2); reserved back to ${delivered.reservedQty} (expected ${before.reservedQty})`);

  // --- reservation already released by the sweeper, then delivered anyway --
  const [late] = await createOrder(prisma, secret, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 1 }] });
  await prisma.order.update({ where: { id: late.id }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
  await releaseExpiredReservations(prisma);
  const afterSweep = await snap("expired reservation swept");
  for (const status of ["PREPARING", "COOKED", "DELIVERED"]) await updateOrderStatus(prisma, late.id, status);
  const afterLate = await snap("swept order delivered anyway");
  console.log(`  stock -1 exactly? ${afterLate.stockQty === afterSweep.stockQty - 1}; reserved not double-credited? ${afterLate.reservedQty === afterSweep.reservedQty}`);

  // --- physical stock pulled from under a placed order --------------------
  const [starved] = await createOrder(prisma, secret, { owner: { studentId: student.id }, items: [{ menuItemId: item.id, qty: 1 }] });
  const held = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: 0 } });
  for (const status of ["PREPARING", "COOKED"]) await updateOrderStatus(prisma, starved.id, status);
  try {
    await updateOrderStatus(prisma, starved.id, "DELIVERED");
    console.log("  DELIVERED accepted — EXPECTED A REJECTION");
  } catch (err: any) {
    console.log(`  DELIVERED rejected: ${err.status} ${err.code} — ${err.message}`);
  }
  const rolled = await prisma.order.findUniqueOrThrow({ where: { id: starved.id } });
  const rolledItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`  order left at ${rolled.status}; settle rolled back? ${rolled.stockSettledAt === null}; reserved untouched? ${rolledItem.reservedQty === held.reservedQty}`);
  await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: held.stockQty } });
} finally {
  const end = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`\nfinal: stock=${end.stockQty} reserved=${end.reservedQty} (started stock=${before.stockQty} reserved=${before.reservedQty}; 3 portions genuinely delivered/held)`);
}
process.exit(0);
