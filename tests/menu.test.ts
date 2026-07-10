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

describe("Menu CRUD + read", () => {
  it("admin creates category and item, student reads categorized menu", async () => {
    const token = await makeAdminToken();

    const catRes = await request(app)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Snacks", sortOrder: 1 });
    expect(catRes.status).toBe(201);

    const itemRes = await request(app)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Samosa",
        imageUrl: "https://example.com/samosa.jpg",
        price: "20.00",
        stockQty: 50,
        categoryId: catRes.body.id,
      });
    expect(itemRes.status).toBe(201);

    const menuRes = await request(app).get("/menu");
    expect(menuRes.status).toBe(200);
    expect(menuRes.body.categories).toHaveLength(1);
    expect(menuRes.body.categories[0].items[0].name).toBe("Samosa");
  });

  it("rejects menu-item creation without admin token", async () => {
    const res = await request(app)
      .post("/admin/menu-items")
      .send({ name: "X", imageUrl: "https://x.com/a.jpg", price: "1", stockQty: 1, categoryId: "nope" });
    expect(res.status).toBe(401);
  });
});
