import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";
import { sql, query } from "../src/db/sql.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";
import type { Order } from "../src/db/schema.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer, seedOrder } from "./helpers/app.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

async function findOrder(id: string): Promise<Order | null> {
  const { rows } = await query<Order>(pool, sql`SELECT * FROM "Order" WHERE "id" = ${id}`);
  return rows[0] ?? null;
}

async function makeAdminToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const admin = await userRepo.insert(pool, {
    role: "ADMIN",
    email: `admin-${Date.now()}-${Math.random()}@klh.edu.in`,
    passwordHash,
    name: "A",
    school: "KLH",
  });
  return { id: admin.id, token: signToken({ sub: admin.id, role: "ADMIN" }, process.env.JWT_SECRET!) };
}

async function makeStudentToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const student = await userRepo.insert(pool, {
    role: "STUDENT",
    rollNumber: `R${Date.now()}-${Math.random()}`,
    email: `s-${Date.now()}-${Math.random()}@klh.edu.in`,
    passwordHash,
    name: "S",
    school: "KLH",
  });
  return signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);
}

async function makeItem(stockQty: number) {
  const category = await categoryRepo.insertCategory(pool, {
    name: `Cat-${Date.now()}-${Math.random()}`,
    sortOrder: 1,
    kitchen: "SNACKS",
  });
  return menuItemRepo.insertMenuItem(pool, {
    name: "Tea",
    imageUrl: "https://x.com/tea.jpg",
    price: "10.00",
    stockQty,
    categoryId: category.id,
  });
}

// Drives an order sequentially through PENDING -> ... -> targetStatus via PATCH calls.
async function advanceOrderTo(orderId: string, adminToken: string, targetStatus: "COOKED" | "DELIVERED") {
  const chain = ["COOKED", "DELIVERED"];
  const targetIndex = chain.indexOf(targetStatus);
  for (let i = 0; i <= targetIndex; i++) {
    const res = await request(server)
      .patch(`/admin/orders/${orderId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: chain[i] });
    expect(res.status).toBe(200);
  }
}

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  // resetDatabase() TRUNCATEs everything (AuditLog included), so the next
  // suite starts clean without this file having to know the FK order.
  await resetDatabase();
  await disconnectTestPrisma();
  await closeTestServer(server);
});

describeDb("Admin order board", () => {
  describe("GET /admin/orders/:id", () => {
    it("opens an order, marks it seen by admin, and returns its items", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 2 }] });
      const { id: orderId } = orderRes.body[0];

      const openRes = await request(server)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${admin.token}`);
      expect(openRes.status).toBe(200);
      expect(openRes.body.id).toBe(orderId);
      expect(openRes.body.items).toHaveLength(1);
      expect(openRes.body.isLockedByOther).toBe(false);

      const dbOrder = await findOrder(orderId);
      expect(dbOrder?.seenByAdmin).toBe(true);
      expect(dbOrder?.seenAt).not.toBeNull();
    });

    it("tells a second admin the order is locked while the first admin has it open", async () => {
      const adminOne = await makeAdminToken();
      const adminTwo = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const firstOpen = await request(server)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${adminOne.token}`);
      expect(firstOpen.status).toBe(200);
      expect(firstOpen.body.isLockedByOther).toBe(false);

      const secondOpen = await request(server)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${adminTwo.token}`);
      expect(secondOpen.status).toBe(200);
      expect(secondOpen.body.isLockedByOther).toBe(true);

      const dbOrder = await findOrder(orderId);
      // Lock stays with the first admin; the second admin did not steal it.
      expect(dbOrder?.lockedByAdminId).toBe(adminOne.id);
    });

    it("rejects non-admin roles with 403", async () => {
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(server)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects PENDING -> PREPARING now that the board is a two-step flow", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "PREPARING" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("still advances a legacy order already sitting in PREPARING to COOKED", async () => {
      const admin = await makeAdminToken();
      const item = await makeItem(5);
      const passwordHash = await bcrypt.hash("x", 12);
      const student = await userRepo.insert(pool, {
        role: "STUDENT",
        rollNumber: `R${Date.now()}-${Math.random()}`,
        email: `s-${Date.now()}-${Math.random()}@klh.edu.in`,
        passwordHash,
        name: "S",
        school: "KLH",
      });
      const legacy = await seedOrder({
        studentId: student.id,
        status: "PREPARING",
        kitchen: "SNACKS",
        menuItemId: item.id,
        qty: 1,
        price: "10.00",
      });

      const res = await request(server)
        .patch(`/admin/orders/${legacy.id}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "COOKED" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("COOKED");
    });

    it("returns 404 for a non-existent order id", async () => {
      const admin = await makeAdminToken();
      const res = await request(server)
        .get("/admin/orders/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${admin.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /admin/orders/:id/status", () => {
    it("walks an order through PENDING -> COOKED -> DELIVERED, 200 at every step", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const { id: orderId } = orderRes.body[0];

      const cooked = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "COOKED" });
      expect(cooked.status).toBe(200);
      expect(cooked.body.status).toBe("COOKED");

      const delivered = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(delivered.status).toBe(200);
      expect(delivered.body.status).toBe("DELIVERED");

      const updatedItem = await menuItemRepo.findMenuItemById(pool, item.id);
      expect(updatedItem?.stockQty).toBe(2);
    });

    it("rejects skipping a step (PENDING straight to DELIVERED)", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("rejects DELIVERED when stock is insufficient", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(1);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");
      await menuItemRepo.updateMenuItem(pool, item.id, { stockQty: 0 });

      const res = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OUT_OF_STOCK");
    });

    it("does not partially decrement stock when one of several line items is out of stock, and leaves the order at its pre-DELIVERED status", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const plentifulItem = await makeItem(10);
      const scarceItem = await makeItem(2);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({
          items: [
            { menuItemId: plentifulItem.id, qty: 3 },
            { menuItemId: scarceItem.id, qty: 2 },
          ],
        });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");

      // Stock drops below what the order needs for just the second item, after
      // it reached COOKED (e.g. another admin delivered a different order for
      // the same item in the meantime).
      await menuItemRepo.updateMenuItem(pool, scarceItem.id, { stockQty: 1 });

      const res = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OUT_OF_STOCK");

      const untouchedItem = await menuItemRepo.findMenuItemById(pool, plentifulItem.id);
      expect(untouchedItem?.stockQty).toBe(10);

      const order = await findOrder(orderId);
      // Stays at COOKED, not reset to PENDING, since it had already progressed.
      expect(order?.status).toBe("COOKED");
    });

    it("rejects delivering an order that was already delivered (double-deliver)", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");

      const firstDeliver = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(firstDeliver.status).toBe(200);

      const secondDeliver = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(secondDeliver.status).toBe(409);
      expect(secondDeliver.body.error.code).toBe("ALREADY_DELIVERED");

      const updatedItem = await menuItemRepo.findMenuItemById(pool, item.id);
      // Only decremented once, not twice.
      expect(updatedItem?.stockQty).toBe(4);
    });

    it("returns 404 for a non-existent order id", async () => {
      const admin = await makeAdminToken();
      const res = await request(server)
        .patch("/admin/orders/00000000-0000-0000-0000-000000000000/status")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "COOKED" });
      expect(res.status).toBe(404);
    });

    it("rejects non-admin roles with 403", async () => {
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(server)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ status: "COOKED" });
      expect(res.status).toBe(403);
    });

    it("delivers 20 concurrent status-update requests for an order already at COOKED exactly once, decrementing stock exactly once", async () => {
      // 20 requests serialize on the same row-level FOR UPDATE lock against a
      // remote DB; the default 5s vitest timeout is too tight for that.
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(server)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");

      const concurrentRequests = Array.from({ length: 20 }, () =>
        request(server)
          .patch(`/admin/orders/${orderId}/status`)
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ status: "DELIVERED" })
      );
      const results = await Promise.all(concurrentRequests);

      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(19);
      for (const conflict of conflicts) {
        expect(conflict.body.error.code).toBe("ALREADY_DELIVERED");
      }

      const updatedItem = await menuItemRepo.findMenuItemById(pool, item.id);
      expect(updatedItem?.stockQty).toBe(2);
    }, 20000);

    it("never oversells: two orders racing for the same scarce stock at DELIVERED admit at most one success and stock never goes negative", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      // Only 5 units in stock. Two separate orders each want 3 (6 > 5).
      const item = await makeItem(5);

      const place = (qty: number) =>
        request(server)
          .post("/orders")
          .set("Authorization", `Bearer ${studentToken}`)
          .send({ items: [{ menuItemId: item.id, qty }] });

      const orderARes = await place(3);
      expect(orderARes.status).toBe(201);

      // Stock reservation moved the refusal forward: the three portions order A
      // holds are already spoken for, so only two are sellable and the second
      // basket is refused at CREATION rather than at delivery. The invariant is
      // the same one the old delivery-time check enforced — the canteen never
      // promises more portions than it has — it is just enforced earlier, and
      // before the student has been told their order exists.
      const orderBRes = await place(3);
      expect(orderBRes.status).toBe(409);
      expect(orderBRes.body.error.code).toBe("OUT_OF_STOCK");
      const { rows: countRows } = await query<{ count: string }>(pool, sql`SELECT COUNT(*)::bigint AS count FROM "Order"`);
      expect(Number(countRows[0].count)).toBe(1);

      // Physical stock has not moved yet; it is only committed on delivery.
      const reserved = await menuItemRepo.findMenuItemById(pool, item.id);
      expect(reserved!.stockQty).toBe(5);

      await advanceOrderTo(orderARes.body[0].id, admin.token, "DELIVERED");

      const settled = await menuItemRepo.findMenuItemById(pool, item.id);
      expect(settled!.stockQty).toBe(2);
      expect(settled!.stockQty).toBeGreaterThanOrEqual(0);
      // The reservation was handed back once the stock was actually consumed,
      // so the remaining two portions are sellable again.
      expect(settled!.stockQty - settled!.reservedQty).toBe(2);

      // And with the shelf now clear, a basket for the remaining two succeeds.
      expect((await place(2)).status).toBe(201);
    }, 10000);
  });
});
