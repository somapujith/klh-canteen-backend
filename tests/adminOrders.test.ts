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
    data: { role: "ADMIN", email: `admin-${Date.now()}@klh.edu.in`, passwordHash, name: "A" },
  });
  return signToken({ sub: admin.id, role: "ADMIN" });
}

async function makeStudentToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const student = await prisma.user.create({
    data: { role: "STUDENT", rollNumber: `R${Date.now()}`, email: `s-${Date.now()}@klh.edu.in`, passwordHash, name: "S" },
  });
  return signToken({ sub: student.id, role: "STUDENT" });
}

async function makeItem(stockQty: number) {
  const category = await prisma.category.create({ data: { name: `Cat-${Date.now()}`, sortOrder: 1 } });
  return prisma.menuItem.create({
    data: { name: "Tea", imageUrl: "https://x.com/tea.jpg", price: "10.00", stockQty, categoryId: category.id },
  });
}

beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Admin scan + deliver", () => {
  it("scans a valid token, then deliver decrements stock and flips status", async () => {
    const adminToken = await makeAdminToken();
    const studentToken = await makeStudentToken();
    const item = await makeItem(5);

    const orderRes = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 3 }] });
    const { id: orderId, token: qrToken } = orderRes.body;

    const scanRes = await request(app)
      .get(`/admin/orders/scan/${qrToken}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(scanRes.status).toBe(200);
    expect(scanRes.body.id).toBe(orderId);

    const deliverRes = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deliverRes.status).toBe(200);
    expect(deliverRes.body.status).toBe("DELIVERED");

    const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
    expect(updatedItem?.stockQty).toBe(2);
  });

  it("rejects deliver when stock is insufficient", async () => {
    const adminToken = await makeAdminToken();
    const studentToken = await makeStudentToken();
    const item = await makeItem(1);

    const orderRes = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });
    const { id: orderId } = orderRes.body;

    await prisma.menuItem.update({ where: { id: item.id }, data: { stockQty: 0 } });

    const deliverRes = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deliverRes.status).toBe(409);
    expect(deliverRes.body.error.code).toBe("OUT_OF_STOCK");
  });

  it("rejects scan with a tampered token", async () => {
    const adminToken = await makeAdminToken();
    const res = await request(app)
      .get("/admin/orders/scan/not-a-real-token")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("rejects a QR from a foreign app (wrong magic prefix / no valid signature)", async () => {
    const adminToken = await makeAdminToken();
    const foreignToken = Buffer.from("SOMEOTHERAPP.12345.payload").toString("base64url");
    const res = await request(app)
      .get(`/admin/orders/scan/${foreignToken}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("does not partially decrement stock when one of several line items is out of stock", async () => {
    const adminToken = await makeAdminToken();
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
    const { id: orderId } = orderRes.body;

    // Stock drops below what the order needs for just the second item, after
    // the order was placed (e.g. another admin delivered a different order
    // for the same item in the meantime).
    await prisma.menuItem.update({ where: { id: scarceItem.id }, data: { stockQty: 1 } });

    const deliverRes = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deliverRes.status).toBe(409);
    expect(deliverRes.body.error.code).toBe("OUT_OF_STOCK");

    const untouchedItem = await prisma.menuItem.findUnique({ where: { id: plentifulItem.id } });
    expect(untouchedItem?.stockQty).toBe(10);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe("PENDING");
  });

  it("rejects delivering an order that was already delivered (double-scan)", async () => {
    const adminToken = await makeAdminToken();
    const studentToken = await makeStudentToken();
    const item = await makeItem(5);

    const orderRes = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });
    const { id: orderId } = orderRes.body;

    const firstDeliver = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(firstDeliver.status).toBe(200);

    const secondDeliver = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(secondDeliver.status).toBe(409);
    expect(secondDeliver.body.error.code).toBe("ALREADY_DELIVERED");

    const updatedItem = await prisma.menuItem.findUnique({ where: { id: item.id } });
    // Only decremented once, not twice.
    expect(updatedItem?.stockQty).toBe(4);
  });

  it("rejects deliver for a non-existent order id with 404", async () => {
    const adminToken = await makeAdminToken();
    const res = await request(app)
      .post("/admin/orders/00000000-0000-0000-0000-000000000000/deliver")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects scan and deliver for non-admin roles", async () => {
    const studentToken = await makeStudentToken();
    const item = await makeItem(5);

    const orderRes = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });
    const { id: orderId, token: qrToken } = orderRes.body;

    const scanRes = await request(app)
      .get(`/admin/orders/scan/${qrToken}`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(scanRes.status).toBe(403);

    const deliverRes = await request(app)
      .post(`/admin/orders/${orderId}/deliver`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(deliverRes.status).toBe(403);
  });

  it("delivers 20 concurrent scan+deliver requests for the same order exactly once, decrementing stock exactly once", async () => {
    const adminToken = await makeAdminToken();
    const studentToken = await makeStudentToken();
    const item = await makeItem(5);

    const orderRes = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${studentToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 3 }] });
    const { id: orderId } = orderRes.body;

    const concurrentRequests = Array.from({ length: 20 }, () =>
      request(app).post(`/admin/orders/${orderId}/deliver`).set("Authorization", `Bearer ${adminToken}`)
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

  it("never oversells: concurrent delivery of two different orders competing for the same scarce stock leaves stock >= 0 and admits at most as many successes as stock allows", async () => {
    const adminToken = await makeAdminToken();
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
    const orderAId = orderARes.body.id;
    const orderBId = orderBRes.body.id;

    const [resA, resB] = await Promise.all([
      request(app).post(`/admin/orders/${orderAId}/deliver`).set("Authorization", `Bearer ${adminToken}`),
      request(app).post(`/admin/orders/${orderBId}/deliver`).set("Authorization", `Bearer ${adminToken}`),
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
