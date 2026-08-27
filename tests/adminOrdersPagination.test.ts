import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { MAX_ORDER_PAGE_SIZE } from "../src/services/orderService.js";
import { issueGuestSession } from "../src/services/guestSessionService.js";
import { describeDb, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import {
  startTestServer,
  closeTestServer,
  createAdmin,
  createStudent,
  createMenuItem,
  seedOrder,
  tokenFor,
} from "./helpers/app.js";

const server = testDb.enabled ? await startTestServer() : (undefined as any);

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

async function adminAuth() {
  const admin = await createAdmin();
  return `Bearer ${tokenFor(admin)}`;
}

/** N student orders, newest first, one minute apart. */
async function seedOrders(count: number, options: { status?: "PENDING" | "DELIVERED" } = {}) {
  const item = await createMenuItem({ stockQty: 500 });
  const student = await createStudent();
  const orders = [];
  for (let i = 0; i < count; i++) {
    orders.push(
      await seedOrder({
        studentId: student.id,
        menuItemId: item.id,
        status: options.status ?? "PENDING",
        createdAt: new Date(Date.now() - i * 60_000),
      }),
    );
  }
  return { orders, item, student };
}

describeDb("GET /admin/orders — response shape", () => {
  it("returns a BARE JSON ARRAY by default, so existing clients that call .map() keep working", async () => {
    const auth = await adminAuth();
    await seedOrders(2);

    const res = await request(server).get("/admin/orders").set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].totalAmount).toBe("20.00");
  });

  it("carries pagination metadata in headers on the bare-array shape", async () => {
    const auth = await adminAuth();
    await seedOrders(3);

    const res = await request(server)
      .get("/admin/orders?limit=2")
      .set("Authorization", auth);

    expect(res.headers["x-has-more"]).toBe("true");
    expect(res.headers["x-next-cursor"]).toBeTruthy();
    // Without this a browser cannot read either header cross-origin, which
    // leaves a paginating frontend unable to ask for page 2.
    expect(res.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
  });

  it("returns { data, nextCursor, hasMore } for ?format=envelope", async () => {
    const auth = await adminAuth();
    await seedOrders(3);

    const res = await request(server)
      .get("/admin/orders?format=envelope&limit=2")
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    expect(typeof res.body.nextCursor).toBe("string");
  });

  it("serves the same rows in both shapes", async () => {
    const auth = await adminAuth();
    await seedOrders(3);

    const bare = await request(server).get("/admin/orders?limit=2").set("Authorization", auth);
    const envelope = await request(server)
      .get("/admin/orders?limit=2&format=envelope")
      .set("Authorization", auth);

    expect(envelope.body.data.map((o: any) => o.id)).toEqual(bare.body.map((o: any) => o.id));
    expect(envelope.body.nextCursor).toBe(bare.headers["x-next-cursor"]);
  });

  it("sets hasMore=false and nextCursor=null on the last page", async () => {
    const auth = await adminAuth();
    await seedOrders(2);

    const res = await request(server)
      .get("/admin/orders?format=envelope&limit=5")
      .set("Authorization", auth);

    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });
});

describeDb("GET /admin/orders — cursor walking", () => {
  it("walks every order exactly once across pages, newest first", async () => {
    const auth = await adminAuth();
    const { orders } = await seedOrders(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string = `/admin/orders?format=envelope&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: any = await request(server).get(url).set("Authorization", auth);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((o: any) => o.id));
      cursor = res.body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // no infinite cursor loops
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    // Newest first — seedOrders created index 0 as the newest.
    expect(seen).toEqual(orders.map((o) => o.id));
  });

  /**
   * The keyset cursor exists because the board is a live feed. With an OFFSET
   * cursor, an order placed between page 1 and page 2 shifts every later page
   * by one and the admin silently never sees a row.
   */
  it("does not skip a row when a new order arrives between two pages", async () => {
    const auth = await adminAuth();
    const { orders, item, student } = await seedOrders(3);

    const page1 = await request(server)
      .get("/admin/orders?format=envelope&limit=2")
      .set("Authorization", auth);
    expect(page1.body.data.map((o: any) => o.id)).toEqual([orders[0]!.id, orders[1]!.id]);

    // A fresh order lands at the top of the feed, mid-scroll.
    await seedOrder({
      studentId: student.id,
      menuItemId: item.id,
      createdAt: new Date(Date.now() + 60_000),
    });

    const page2 = await request(server)
      .get(`/admin/orders?format=envelope&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set("Authorization", auth);

    expect(page2.body.data.map((o: any) => o.id)).toContain(orders[2]!.id);
  });

  it("rejects a malformed cursor with 400 INVALID_CURSOR instead of returning junk", async () => {
    const auth = await adminAuth();
    await seedOrders(1);

    const res = await request(server)
      .get("/admin/orders?cursor=notacursor")
      .set("Authorization", auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });

  it(`refuses to lift the page ceiling above ${MAX_ORDER_PAGE_SIZE}`, async () => {
    const auth = await adminAuth();
    const res = await request(server)
      .get("/admin/orders?limit=100000")
      .set("Authorization", auth);

    expect(res.status).toBe(400);
  });
});

describeDb("GET /admin/orders — active-only default", () => {
  it("omits DELIVERED orders unless they are asked for", async () => {
    const auth = await adminAuth();
    const item = await createMenuItem({ stockQty: 100 });
    const student = await createStudent();
    const live = await seedOrder({ studentId: student.id, menuItemId: item.id, status: "PENDING" });
    const done = await seedOrder({ studentId: student.id, menuItemId: item.id, status: "DELIVERED" });

    const board = await request(server).get("/admin/orders").set("Authorization", auth);
    const ids = board.body.map((o: any) => o.id);

    expect(ids).toContain(live.id);
    expect(ids).not.toContain(done.id);
  });

  it("includes DELIVERED orders for ?active=false", async () => {
    const auth = await adminAuth();
    const item = await createMenuItem({ stockQty: 100 });
    const student = await createStudent();
    const done = await seedOrder({ studentId: student.id, menuItemId: item.id, status: "DELIVERED" });

    const res = await request(server).get("/admin/orders?active=false").set("Authorization", auth);

    expect(res.body.map((o: any) => o.id)).toContain(done.id);
  });

  it("filters by explicit status", async () => {
    const auth = await adminAuth();
    const item = await createMenuItem({ stockQty: 100 });
    const student = await createStudent();
    const pending = await seedOrder({ studentId: student.id, menuItemId: item.id, status: "PENDING" });
    const preparing = await seedOrder({
      studentId: student.id,
      menuItemId: item.id,
      status: "PREPARING",
    });

    const res = await request(server)
      .get("/admin/orders?status=PREPARING")
      .set("Authorization", auth);

    const ids = res.body.map((o: any) => o.id);
    expect(ids).toContain(preparing.id);
    expect(ids).not.toContain(pending.id);
  });

  it("rejects an unknown status rather than silently returning everything", async () => {
    const auth = await adminAuth();
    const res = await request(server)
      .get("/admin/orders?status=BANANA")
      .set("Authorization", auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });

  it("scopes a kitchen-bound admin to their own kitchen", async () => {
    const snacksAdmin = await createAdmin({ kitchen: "SNACKS" });
    const auth = `Bearer ${tokenFor(snacksAdmin)}`;
    const snackItem = await createMenuItem({ kitchen: "SNACKS" });
    const student = await createStudent();
    const mine = await seedOrder({ studentId: student.id, menuItemId: snackItem.id, kitchen: "SNACKS" });
    const theirs = await seedOrder({ studentId: student.id, menuItemId: snackItem.id, kitchen: "MEALS" });

    const res = await request(server).get("/admin/orders").set("Authorization", auth);
    const ids = res.body.map((o: any) => o.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });
});

/**
 * Guest orders have `studentId = NULL`. Every admin view used to reach through
 * `order.student` for the name shown on the board, so a single guest order is
 * enough to break the whole board for everyone.
 */
describeDb("admin views tolerate guest orders (NULL studentId)", () => {
  async function seedGuestOrder(overrides: { guestName?: string | null } = {}) {
    const item = await createMenuItem({ stockQty: 100 });
    const session = issueGuestSession(process.env.QR_TOKEN_SECRET!);
    const order = await seedOrder({
      guestSessionId: session.sessionId,
      guestName: overrides.guestName === undefined ? "Ana" : overrides.guestName,
      guestPhone: "9999",
      menuItemId: item.id,
    });
    return { order, session, item };
  }

  it("lists a guest order without crashing and labels it as a guest", async () => {
    const auth = await adminAuth();
    const { order } = await seedGuestOrder();

    const res = await request(server).get("/admin/orders").set("Authorization", auth);

    expect(res.status).toBe(200);
    const row = res.body.find((o: any) => o.id === order.id);
    expect(row).toBeDefined();
    expect(row.student).toBeNull();
    expect(row.customer.type).toBe("GUEST");
    expect(row.customer.name).toBe("Ana");
    expect(row.customer.rollNumber).toBeNull();
  });

  it("falls back to a usable label for an anonymous guest", async () => {
    const auth = await adminAuth();
    const { order } = await seedGuestOrder({ guestName: null });

    const res = await request(server).get("/admin/orders").set("Authorization", auth);
    const row = res.body.find((o: any) => o.id === order.id);

    expect(row.customer.name).toBe("Guest");
  });

  it("never leaks the guest session id to an admin", async () => {
    const auth = await adminAuth();
    const { order, session } = await seedGuestOrder();

    const res = await request(server).get("/admin/orders").set("Authorization", auth);
    const row = res.body.find((o: any) => o.id === order.id);

    expect(row.customer.id).toBeNull();
    expect(JSON.stringify(row.customer)).not.toContain(session.sessionId);
  });

  it("opens a guest order on GET /admin/orders/:id", async () => {
    const auth = await adminAuth();
    const { order } = await seedGuestOrder();

    const res = await request(server)
      .get(`/admin/orders/${order.id}`)
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.customer.type).toBe("GUEST");
    expect(res.body.student).toBeNull();
  });

  it("advances a guest order's status without a student to notify", async () => {
    const auth = await adminAuth();
    const { order } = await seedGuestOrder();

    const res = await request(server)
      .patch(`/admin/orders/${order.id}/status`)
      .set("Authorization", auth)
      .send({ status: "COOKED" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COOKED");
  });

  it("mixes guest and student orders on one page", async () => {
    const auth = await adminAuth();
    const { order: guestOrder, item } = await seedGuestOrder();
    const student = await createStudent({ name: "Ravi" });
    const studentOrder = await seedOrder({ studentId: student.id, menuItemId: item.id });

    const res = await request(server)
      .get("/admin/orders?format=envelope")
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.map((o: any) => [o.id, o]));
    expect((byId.get(guestOrder.id) as any).customer.type).toBe("GUEST");
    expect((byId.get(studentOrder.id) as any).customer.type).toBe("STUDENT");
    expect((byId.get(studentOrder.id) as any).customer.name).toBe("Ravi");
  });
});
