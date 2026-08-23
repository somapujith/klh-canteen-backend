import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import {
  resolveCollectionSlot,
  normaliseCollectionSlot,
  COLLECTION_SLOT_MINUTES,
  MAX_PREBOOK_DAYS,
} from "../src/services/orderService.js";
import { ApiError } from "../src/middleware/errorHandler.js";
import { issueGuestSession } from "../src/services/guestSessionService.js";
import { describeDb, getTestPrisma, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer, createMenuItem } from "./helpers/app.js";

const prisma = testDb.enabled ? getTestPrisma() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

const SESSION_HEADER = "X-Guest-Session";
const SECRET = process.env.QR_TOKEN_SECRET!;

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

/** A slot start comfortably in the future, aligned to the slot grid. */
function futureSlot(minutesAhead = 90): Date {
  return normaliseCollectionSlot(new Date(Date.now() + minutesAhead * 60 * 1000));
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ApiError).code;
  }
  throw new Error("expected the call to throw, it did not");
}

describe("collection slot resolution (no database needed)", () => {
  it("treats an absent collection time as ASAP (null), which is what every old client sends", () => {
    expect(resolveCollectionSlot(undefined)).toBeNull();
    expect(resolveCollectionSlot(null)).toBeNull();
  });

  it("floors a requested time down to its slot start", () => {
    const slotMs = COLLECTION_SLOT_MINUTES * 60 * 1000;
    const base = futureSlot();
    const offset = new Date(base.getTime() + 7 * 60 * 1000 + 31_000);

    const resolved = resolveCollectionSlot(offset)!;
    expect(resolved.getTime()).toBe(base.getTime());
    expect(resolved.getTime() % slotMs).toBe(0);
  });

  it("rejects a time in the past with COLLECTION_WINDOW_PAST", () => {
    expect(errorCode(() => resolveCollectionSlot(new Date(Date.now() - 60 * 60 * 1000)))).toBe(
      "COLLECTION_WINDOW_PAST",
    );
  });

  it("accepts the current slot even though its start is already behind us", () => {
    // Someone ordering at 12:07 for "now" must not be told 12:00 has passed.
    expect(resolveCollectionSlot(new Date())).not.toBeNull();
  });

  it(`rejects a time beyond the ${MAX_PREBOOK_DAYS}-day horizon`, () => {
    const tooFar = new Date(Date.now() + (MAX_PREBOOK_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(errorCode(() => resolveCollectionSlot(tooFar))).toBe("COLLECTION_WINDOW_TOO_FAR");
  });

  it("rejects an unparseable date rather than silently booking ASAP", () => {
    expect(errorCode(() => resolveCollectionSlot(new Date("nonsense")))).toBe(
      "INVALID_COLLECTION_WINDOW",
    );
  });
});

describeDb("pre-booking through POST /guest/orders", () => {
  async function place(body: Record<string, unknown>) {
    return request(server)
      .post("/guest/orders")
      .set(SESSION_HEADER, issueGuestSession(SECRET).token)
      .send(body);
  }

  it("stores collectionAt = NULL when the client omits it (ASAP)", async () => {
    const item = await createMenuItem({ stockQty: 10 });

    const res = await place({ items: [{ menuItemId: item.id, qty: 1 }] });

    expect(res.status).toBe(201);
    const stored = await prisma.order.findUnique({ where: { id: res.body[0].id } });
    expect(stored!.collectionAt).toBeNull();
    // ASAP orders take no window seat at all.
    expect(await prisma.collectionWindow.count()).toBe(0);
  });

  it("books a seat in the requested window and floors the time to the slot", async () => {
    const item = await createMenuItem({ stockQty: 10 });
    const slot = futureSlot();
    const requested = new Date(slot.getTime() + 6 * 60 * 1000);

    const res = await place({
      items: [{ menuItemId: item.id, qty: 1 }],
      collectionAt: requested.toISOString(),
    });

    expect(res.status).toBe(201);
    const stored = await prisma.order.findUnique({ where: { id: res.body[0].id } });
    expect(stored!.collectionAt!.toISOString()).toBe(slot.toISOString());

    const window = await prisma.collectionWindow.findFirst({ where: { startAt: slot } });
    expect(window!.bookedCount).toBe(1);
  });

  it("rejects a past collection time with 400 COLLECTION_WINDOW_PAST", async () => {
    const item = await createMenuItem({ stockQty: 10 });

    const res = await place({
      items: [{ menuItemId: item.id, qty: 1 }],
      collectionAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("COLLECTION_WINDOW_PAST");
    // Nothing was written: the time is validated before the transaction opens.
    expect(await prisma.order.count()).toBe(0);
  });

  it(`rejects a time more than ${MAX_PREBOOK_DAYS} days ahead`, async () => {
    const item = await createMenuItem({ stockQty: 10 });

    const res = await place({
      items: [{ menuItemId: item.id, qty: 1 }],
      collectionAt: new Date(Date.now() + (MAX_PREBOOK_DAYS + 1) * 86_400_000).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("COLLECTION_WINDOW_TOO_FAR");
  });

  it("returns 409 COLLECTION_WINDOW_FULL once the window's capacity is used up", async () => {
    const item = await createMenuItem({ stockQty: 50 });
    const slot = futureSlot();
    await prisma.collectionWindow.create({
      data: { startAt: slot, kitchen: "SNACKS", capacity: 1, bookedCount: 0 },
    });

    const first = await place({
      items: [{ menuItemId: item.id, qty: 1 }],
      collectionAt: slot.toISOString(),
    });
    expect(first.status).toBe(201);

    const second = await place({
      items: [{ menuItemId: item.id, qty: 1 }],
      collectionAt: slot.toISOString(),
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("COLLECTION_WINDOW_FULL");

    // The refused order left nothing behind, and the seat count did not move.
    expect(await prisma.order.count()).toBe(1);
    const window = await prisma.collectionWindow.findFirst({ where: { startAt: slot } });
    expect(window!.bookedCount).toBe(1);
  });

  it("still serves ASAP orders for a kitchen whose window is full", async () => {
    const item = await createMenuItem({ stockQty: 50 });
    const slot = futureSlot();
    await prisma.collectionWindow.create({
      data: { startAt: slot, kitchen: "SNACKS", capacity: 1, bookedCount: 1 },
    });

    const asap = await place({ items: [{ menuItemId: item.id, qty: 1 }] });
    expect(asap.status).toBe(201);
  });

  /**
   * THE CAPACITY CEILING IS ATOMIC.
   *
   * A read-then-write ("is bookedCount < capacity? then +1") lets N concurrent
   * bookings all observe the same value and all commit, over-committing the
   * kitchen. This fires many bookings at one 3-seat window simultaneously and
   * requires exactly three winners.
   */
  it("admits exactly `capacity` orders when 12 bookings race for 3 seats", async () => {
    const item = await createMenuItem({ stockQty: 200 });
    const slot = futureSlot();
    const capacity = 3;
    await prisma.collectionWindow.create({
      data: { startAt: slot, kitchen: "SNACKS", capacity, bookedCount: 0 },
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        place({ items: [{ menuItemId: item.id, qty: 1 }], collectionAt: slot.toISOString() }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const full = results.filter(
      (r) => r.status === 409 && r.body?.error?.code === "COLLECTION_WINDOW_FULL",
    );

    expect(created).toHaveLength(capacity);
    expect(created.length + full.length).toBe(12);

    const window = await prisma.collectionWindow.findFirst({ where: { startAt: slot } });
    expect(window!.bookedCount).toBe(capacity);
    expect(window!.bookedCount).toBeLessThanOrEqual(window!.capacity);
    expect(await prisma.order.count({ where: { collectionAt: slot } })).toBe(capacity);
  });

  it("claims a seat in EACH kitchen's window for a cart that spans both", async () => {
    const snack = await createMenuItem({ stockQty: 10, kitchen: "SNACKS" });
    const meal = await createMenuItem({ stockQty: 10, kitchen: "MEALS" });
    const slot = futureSlot();

    const res = await place({
      items: [
        { menuItemId: snack.id, qty: 1 },
        { menuItemId: meal.id, qty: 1 },
      ],
      collectionAt: slot.toISOString(),
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);

    const windows = await prisma.collectionWindow.findMany({ where: { startAt: slot } });
    expect(windows.map((w: { kitchen: string }) => w.kitchen).sort()).toEqual(["MEALS", "SNACKS"]);
    expect(windows.every((w: { bookedCount: number }) => w.bookedCount === 1)).toBe(true);
  });

  it("does not half-book a two-kitchen cart when one kitchen's window is full", async () => {
    const snack = await createMenuItem({ stockQty: 10, kitchen: "SNACKS" });
    const meal = await createMenuItem({ stockQty: 10, kitchen: "MEALS" });
    const slot = futureSlot();
    await prisma.collectionWindow.create({
      data: { startAt: slot, kitchen: "MEALS", capacity: 1, bookedCount: 1 },
    });

    const res = await place({
      items: [
        { menuItemId: snack.id, qty: 1 },
        { menuItemId: meal.id, qty: 1 },
      ],
      collectionAt: slot.toISOString(),
    });

    expect(res.status).toBe(409);
    // The SNACKS half must not survive the failed MEALS half.
    expect(await prisma.order.count()).toBe(0);
    const snacksWindow = await prisma.collectionWindow.findFirst({
      where: { startAt: slot, kitchen: "SNACKS" },
    });
    expect(snacksWindow?.bookedCount ?? 0).toBe(0);
  });
});

describeDb("GET /guest/collection-windows", () => {
  it("reports remaining capacity so a client can grey out full slots", async () => {
    const slot = futureSlot();
    await prisma.collectionWindow.create({
      data: { startAt: slot, kitchen: "SNACKS", capacity: 4, bookedCount: 4 },
    });

    const res = await request(server)
      .get("/guest/collection-windows?kitchen=SNACKS")
      .set(SESSION_HEADER, issueGuestSession(SECRET).token);

    expect(res.status).toBe(200);
    const window = res.body.find((w: any) => new Date(w.startAt).getTime() === slot.getTime());
    expect(window).toBeDefined();
    expect(window.remaining).toBe(0);
    expect(window.isFull).toBe(true);
  });
});
