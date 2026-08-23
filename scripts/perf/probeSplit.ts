// Exercises the two paths the fast create() has to keep working: a cart that
// spans both kitchens, and a pre-booked cart that must win a window seat.
import "dotenv/config";
import { getPrisma } from "../../src/lib/prisma.js";
import { createOrder, cancelOrder, normaliseCollectionSlot } from "../../src/services/orderService.js";

const prisma = getPrisma(process.env.DATABASE_URL!);
const secret = process.env.QR_TOKEN_SECRET!;
const student = await prisma.user.findFirstOrThrow({ where: { role: "STUDENT", isActive: true } });

const snack = await prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, category: { kitchen: "SNACKS" } } });
const meal = await prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, category: { kitchen: "MEALS" } } });
const items = [{ menuItemId: snack.id, qty: 1 }, { menuItemId: meal.id, qty: 1 }];
const cleanup: string[] = [];

const split = await createOrder(prisma, secret, { owner: { studentId: student.id }, items });
cleanup.push(...split.map((o) => o.id));
console.log("cross-kitchen cart ->", split.map((o) => `${o.kitchen}#${o.orderNumber} total=${o.totalAmount} items=${o.items.length} student=${o.student?.name}`).join("  |  "));

const slot = normaliseCollectionSlot(new Date(Date.now() + 90 * 60 * 1000));
const booked = await createOrder(prisma, secret, { owner: { studentId: student.id }, items, collectionAt: slot });
cleanup.push(...booked.map((o) => o.id));
console.log("pre-booked cart   ->", booked.map((o) => `${o.kitchen}#${o.orderNumber} collectionAt=${o.collectionAt?.toISOString()}`).join("  |  "));
const windows = await prisma.collectionWindow.findMany({ where: { startAt: slot } });
console.log("window ledger     ->", windows.map((w) => `${w.kitchen} ${w.bookedCount}/${w.capacity}`).join("  |  "));

// Duplicate line items in one cart must collapse into a single claim.
const dup = await createOrder(prisma, secret, {
  owner: { studentId: student.id },
  items: [{ menuItemId: snack.id, qty: 2 }, { menuItemId: snack.id, qty: 3 }],
});
cleanup.push(...dup.map((o) => o.id));
console.log("duplicate lines   ->", dup.map((o) => `#${o.orderNumber} lines=${o.items.length} qty=${o.items.map((i) => i.quantity).join("+")} total=${o.totalAmount}`).join(""));

// Guest ownership still works off the same path.
const guest = await createOrder(prisma, secret, {
  owner: { guestSessionId: "probe-" + crypto.randomUUID(), guestName: "Probe Guest", guestPhone: "0000000000" },
  items: [{ menuItemId: snack.id, qty: 1 }],
});
cleanup.push(...guest.map((o) => o.id));
console.log("guest cart        ->", guest.map((o) => `#${o.orderNumber} student=${o.student} guestName=${o.guestName}`).join(""));

for (const id of cleanup) await cancelOrder(prisma, id);
const after = await prisma.menuItem.findMany({ where: { id: { in: [snack.id, meal.id] } }, select: { name: true, stockQty: true, reservedQty: true } });
console.log("after cancelling all probe orders ->", JSON.stringify(after));
process.exit(0);
