import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";

import { describeDb, getTestPrisma, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const prisma = testDb.enabled ? getTestPrisma() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

async function makeAdminToken() {
  const passwordHash = await bcrypt.hash("x", 12);
  const admin = await prisma.user.create({
    data: { role: "ADMIN", email: `admin-${Date.now()}@klh.edu.in`, passwordHash, name: "A" },
  });
  return signToken({ sub: admin.id, role: "ADMIN" }, process.env.JWT_SECRET!);
}

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

describeDb("Menu CRUD + read", () => {
  it("admin creates category and item, student reads categorized menu", async () => {
    const token = await makeAdminToken();

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Snacks", sortOrder: 1 });
    expect(catRes.status).toBe(201);

    const itemRes = await request(server)
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

    const menuRes = await request(server).get("/menu");
    expect(menuRes.status).toBe(200);
    expect(menuRes.body.categories).toHaveLength(1);
    expect(menuRes.body.categories[0].items[0].name).toBe("Samosa");
  });

  it("rejects menu-item creation without admin token", async () => {
    const res = await request(server)
      .post("/admin/menu-items")
      .send({ name: "X", imageUrl: "https://x.com/a.jpg", price: "1", stockQty: 1, categoryId: "nope" });
    expect(res.status).toBe(401);
  });
});

/**
 * The menu means different things to a customer and to an admin, and the two
 * projections used to be the same raw row. Both directions were wrong.
 */
describeDb("Menu availability projection", () => {
  async function seedItem(stockQty: number, reservedQty: number, isAvailable = true) {
    const category = await prisma.category.create({
      data: { name: `Cat-${Date.now()}-${Math.round(stockQty * 1000 + reservedQty)}`, sortOrder: 0, kitchen: "SNACKS" },
    });
    const item = await prisma.menuItem.create({
      data: {
        name: "Masala Chai",
        price: "15.00",
        imageUrl: "https://example.test/chai.png",
        stockQty,
        reservedQty,
        isAvailable,
        categoryId: category.id,
      },
    });
    return { category, item };
  }

  function findItem(body: any, id: string) {
    for (const category of body.categories) {
      const match = category.items.find((i: any) => i.id === id);
      if (match) return match;
    }
    return undefined;
  }

  it("shows a customer only what is still buyable, not what others have reserved", async () => {
    const { item } = await seedItem(10, 4);

    const res = await request(server).get("/menu");

    expect(res.status).toBe(200);
    // 10 physical, 4 already claimed by uncollected orders => 6 buyable.
    expect(findItem(res.body, item.id).stockQty).toBe(6);
  });

  it("reads as sold out to a customer when every portion is reserved", async () => {
    const { item } = await seedItem(5, 5);

    const res = await request(server).get("/menu");

    const found = findItem(res.body, item.id);
    // Present but unbuyable, which is what the menu already renders for zero
    // stock — rather than vanishing, or advertising portions that would fail
    // at the claim after the student had committed.
    expect(found).toBeDefined();
    expect(found.stockQty).toBe(0);
    expect(found.isAvailable).toBe(false);
  });

  it("never reports negative stock to a customer", async () => {
    const { item } = await seedItem(2, 7);

    const res = await request(server).get("/menu");

    expect(findItem(res.body, item.id).stockQty).toBe(0);
  });

  it("gives an admin the physical count to restock against, not the buyable one", async () => {
    const token = await makeAdminToken();
    const { item } = await seedItem(10, 4);

    const res = await request(server)
      .get("/menu?admin=true")
      .set("Authorization", `Bearer ${token}`);

    const found = findItem(res.body, item.id);
    expect(found.stockQty).toBe(10);
    expect(found.reservedQty).toBe(4);
  });

  /**
   * The regression that made hiding an item a one-way door: the admin page
   * fetched the customer projection, which filters switched-off items out, so
   * the only screen that could un-hide an item could not see it.
   */
  it("keeps switched-off items visible to an admin and hidden from customers", async () => {
    const token = await makeAdminToken();
    const { item } = await seedItem(8, 0, false);

    const adminRes = await request(server)
      .get("/menu?admin=true")
      .set("Authorization", `Bearer ${token}`);
    expect(findItem(adminRes.body, item.id)).toBeDefined();

    const customerRes = await request(server).get("/menu");
    expect(findItem(customerRes.body, item.id)).toBeUndefined();
  });
});
