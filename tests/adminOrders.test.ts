import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { signToken } from "../src/lib/jwt.js";

const app = createApp();

async function makeAdminToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const admin = await prisma.user.create({
    data: { role: "ADMIN", email: `admin-${Date.now()}-${Math.random()}@klh.edu.in`, passwordHash, name: "A" },
  });
  return { id: admin.id, token: signToken({ sub: admin.id, role: "ADMIN" }) };
}

async function makeStudentToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const student = await prisma.user.create({
    data: { role: "STUDENT", rollNumber: `R${Date.now()}-${Math.random()}`, email: `s-${Date.now()}-${Math.random()}@klh.edu.in`, passwordHash, name: "S" },
  });
  return signToken({ sub: student.id, role: "STUDENT" });
}

async function makeItem(stockQty: number) {
  const category = await prisma.category.create({ data: { name: `Cat-${Date.now()}-${Math.random()}`, sortOrder: 1 } });
  return prisma.menuItem.create({
    data: { name: "Tea", imageUrl: "https://x.com/tea.jpg", price: "10.00", stockQty, categoryId: category.id },
  });
}

// Drives an order sequentially through PENDING -> ... -> targetStatus via PATCH calls.
async function advanceOrderTo(orderId: string, adminToken: string, targetStatus: "PREPARING" | "COOKED" | "DELIVERED") {
  const chain = ["PREPARING", "COOKED", "DELIVERED"];
  const targetIndex = chain.indexOf(targetStatus);
  for (let i = 0; i <= targetIndex; i++) {
    const res = await request(app)
      .patch(`/admin/orders/${orderId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: chain[i] });
    expect(res.status).toBe(200);
  }
}

beforeEach(async () => {
  // AuditLog rows (written by logAction for kitchen-less test admins) must be
  // cleared before Order/User, or User.deleteMany() 409s on the RESTRICT FK.
  await prisma.auditLog.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Admin order board", () => {
  describe("GET /admin/orders/:id", () => {
    it("opens an order, marks it seen by admin, and returns its items", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 2 }] });
      const { id: orderId } = orderRes.body[0];

      const openRes = await request(app)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${admin.token}`);
      expect(openRes.status).toBe(200);
      expect(openRes.body.id).toBe(orderId);
      expect(openRes.body.items).toHaveLength(1);
      expect(openRes.body.isLockedByOther).toBe(false);

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.seenByAdmin).toBe(true);
      expect(dbOrder?.seenAt).not.toBeNull();
    });

    it("tells a second admin the order is locked while the first admin has it open", async () => {
      const adminOne = await makeAdminToken();
      const adminTwo = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const firstOpen = await request(app)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${adminOne.token}`);
      expect(firstOpen.status).toBe(200);
      expect(firstOpen.body.isLockedByOther).toBe(false);

      const secondOpen = await request(app)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${adminTwo.token}`);
      expect(secondOpen.status).toBe(200);
      expect(secondOpen.body.isLockedByOther).toBe(true);

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      // Lock stays with the first admin; the second admin did not steal it.
      expect(dbOrder?.lockedByAdminId).toBe(adminOne.id);
    });

    it("rejects non-admin roles with 403", async () => {
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(app)
        .get(`/admin/orders/${orderId}`)
        .set("Authorization", `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
    });

    it("returns 404 for a non-existent order id", async () => {
      const admin = await makeAdminToken();
      const res = await request(app)
        .get("/admin/orders/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${admin.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /admin/orders/:id/status", () => {
    it("walks an order through PENDING -> PREPARING -> COOKED -> DELIVERED, 200 at every step", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const { id: orderId } = orderRes.body[0];

      const preparing = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "PREPARING" });
      expect(preparing.status).toBe(200);
      expect(preparing.body.status).toBe("PREPARING");

      const cooked = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "COOKED" });
      expect(cooked.status).toBe(200);
      expect(cooked.body.status).toBe("COOKED");

      const delivered = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(delivered.status).toBe(200);
      expect(delivered.body.status).toBe("DELIVERED");

      const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
      expect(updatedItem?.stockQty).toBe(2);
    });

    it("rejects skipping a step (PENDING straight to COOKED)", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "COOKED" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("rejects skipping a step (PENDING straight to DELIVERED)", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(app)
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

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");
      await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: 0 } });

      const res = await request(app)
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

      const orderRes = await request(app)
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
      await prisma.menuItem.update({ where: { id: scarceItem.id }, data: { stockQty: 1 } });

      const res = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OUT_OF_STOCK");

      const untouchedItem = await prisma.menuItem.findUnique({ where: { id: plentifulItem.id } });
      expect(untouchedItem?.stockQty).toBe(10);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      // Stays at COOKED, not reset to PENDING, since it had already progressed.
      expect(order?.status).toBe("COOKED");
    });

    it("rejects delivering an order that was already delivered (double-deliver)", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");

      const firstDeliver = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(firstDeliver.status).toBe(200);

      const secondDeliver = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "DELIVERED" });
      expect(secondDeliver.status).toBe(409);
      expect(secondDeliver.body.error.code).toBe("ALREADY_DELIVERED");

      const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
      // Only decremented once, not twice.
      expect(updatedItem?.stockQty).toBe(4);
    });

    it("returns 404 for a non-existent order id", async () => {
      const admin = await makeAdminToken();
      const res = await request(app)
        .patch("/admin/orders/00000000-0000-0000-0000-000000000000/status")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "PREPARING" });
      expect(res.status).toBe(404);
    });

    it("rejects non-admin roles with 403", async () => {
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 1 }] });
      const { id: orderId } = orderRes.body[0];

      const res = await request(app)
        .patch(`/admin/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ status: "PREPARING" });
      expect(res.status).toBe(403);
    });

    it("delivers 20 concurrent status-update requests for an order already at COOKED exactly once, decrementing stock exactly once", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      const item = await makeItem(5);

      const orderRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const { id: orderId } = orderRes.body[0];

      await advanceOrderTo(orderId, admin.token, "COOKED");

      const concurrentRequests = Array.from({ length: 20 }, () =>
        request(app)
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

      const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
      expect(updatedItem?.stockQty).toBe(2);
    });

    it("never oversells: two orders racing for the same scarce stock at DELIVERED admit at most one success and stock never goes negative", async () => {
      const admin = await makeAdminToken();
      const studentToken = await makeStudentToken();
      // Only 5 units in stock. Two separate orders each want 3 units (6 total demand > 5 supply).
      // At most one of the two deliveries may succeed; stock must never go negative.
      const item = await makeItem(5);

      const orderARes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const orderBRes = await request(app)
        .post("/orders")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ items: [{ menuItemId: item.id, qty: 3 }] });
      const orderAId = orderARes.body[0].id;
      const orderBId = orderBRes.body[0].id;

      await advanceOrderTo(orderAId, admin.token, "COOKED");
      await advanceOrderTo(orderBId, admin.token, "COOKED");

      const [resA, resB] = await Promise.all([
        request(app)
          .patch(`/admin/orders/${orderAId}/status`)
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ status: "DELIVERED" }),
        request(app)
          .patch(`/admin/orders/${orderBId}/status`)
          .set("Authorization", `Bearer ${admin.token}`)
          .send({ status: "DELIVERED" }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one succeeds (200) and the other is rejected as out of stock (409),
      // since 5 units of stock cannot satisfy two orders of 3 units each.
      expect(statuses).toEqual([200, 409]);

      const failed = resA.status === 409 ? resA : resB;
      expect(failed.body.error.code).toBe("OUT_OF_STOCK");

      const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
      expect(updatedItem?.stockQty).toBe(2);
      expect(updatedItem!.stockQty).toBeGreaterThanOrEqual(0);
    });
  });
});
