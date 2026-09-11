import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { signToken } from "../src/lib/jwt.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import { sql, query } from "../src/db/sql.js";
import type { MenuItem } from "../src/db/schema.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

async function makeAdminToken(school: "KLH" | "DRK" = "KLH") {
  const passwordHash = await bcrypt.hash("x", 12);
  const admin = await userRepo.insert(pool, {
    role: "ADMIN",
    email: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@klh.edu.in`,
    passwordHash,
    name: "A",
    school,
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
    const category = await categoryRepo.insertCategory(pool, {
      name: `Cat-${Date.now()}-${Math.round(stockQty * 1000 + reservedQty)}`,
      sortOrder: 0,
      kitchen: "SNACKS",
      school: "KLH",
    });
    // MenuItemCreateInput always starts at reservedQty=0/isAvailable=true, so
    // this test's non-default starting state is inserted directly.
    const { rows } = await query<MenuItem>(
      pool,
      sql`
        INSERT INTO "MenuItem" ("id", "name", "imageUrl", "price", "stockQty", "reservedQty", "isAvailable", "categoryId")
        VALUES (${crypto.randomUUID()}, 'Masala Chai', 'https://example.test/chai.png', '15.00', ${stockQty}, ${reservedQty}, ${isAvailable}, ${category.id})
        RETURNING *
      `,
    );
    return { category, item: rows[0] };
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

/**
 * Category and MenuItem inventory is now school-scoped (Category.school,
 * MenuItem.school — denormalized from the owning category). KLH and DRK admins
 * must never be able to read, create, edit, or delete across that boundary,
 * and a school-less menu read must not leak the other school's rows.
 */
describeDb("Menu school isolation", () => {
  it("denormalizes a new item's school from its category, not from a caller-supplied value", async () => {
    const token = await makeAdminToken("KLH");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "KLH Snacks", sortOrder: 1 });
    expect(catRes.status).toBe(201);
    expect(catRes.body.school).toBe("KLH");

    const itemRes = await request(server)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Vada Pav",
        price: "15.00",
        stockQty: 10,
        categoryId: catRes.body.id,
      });
    expect(itemRes.status).toBe(201);
    expect(itemRes.body.school).toBe("KLH");
  });

  it("a DRK admin cannot create a category tagged KLH — it always takes the creating admin's own school", async () => {
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ name: "DRK Snacks", sortOrder: 1 });

    expect(catRes.status).toBe(201);
    expect(catRes.body.school).toBe("DRK");
  });

  it("blocks a DRK admin from editing a KLH category", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Meals", sortOrder: 1 });
    expect(catRes.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/admin/categories/${catRes.body.id}`)
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ name: "Hijacked" });

    expect(patchRes.status).toBe(403);
    expect(patchRes.body.code ?? patchRes.body.error).toBeDefined();
  });

  it("blocks a DRK admin from deleting a KLH category", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Beverages", sortOrder: 1 });
    expect(catRes.status).toBe(201);

    const delRes = await request(server)
      .delete(`/admin/categories/${catRes.body.id}`)
      .set("Authorization", `Bearer ${drkToken}`);

    expect(delRes.status).toBe(403);
  });

  it("blocks a DRK admin from adding an item to a KLH category", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Combo", sortOrder: 1 });
    expect(catRes.status).toBe(201);

    const itemRes = await request(server)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${drkToken}`)
      .send({
        name: "Smuggled Item",
        price: "10.00",
        stockQty: 5,
        categoryId: catRes.body.id,
      });

    expect(itemRes.status).toBe(403);
  });

  it("blocks a DRK admin from editing or deleting a KLH menu item", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Desserts", sortOrder: 1 });
    const itemRes = await request(server)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({
        name: "Gulab Jamun",
        price: "25.00",
        stockQty: 20,
        categoryId: catRes.body.id,
      });
    expect(itemRes.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/admin/menu-items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ stockQty: 999 });
    expect(patchRes.status).toBe(403);

    const delRes = await request(server)
      .delete(`/admin/menu-items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${drkToken}`);
    expect(delRes.status).toBe(403);
  });

  it("scopes the public menu read to the requested school only", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const klhCat = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: `KLH-Only-${Date.now()}`, sortOrder: 1 });
    await request(server)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Item", price: "5.00", stockQty: 5, categoryId: klhCat.body.id });

    const drkCat = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ name: `DRK-Only-${Date.now()}`, sortOrder: 1 });
    await request(server)
      .post("/admin/menu-items")
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ name: "DRK Item", price: "5.00", stockQty: 5, categoryId: drkCat.body.id });

    const klhMenu = await request(server).get("/menu?school=KLH");
    expect(klhMenu.status).toBe(200);
    const klhNames = klhMenu.body.categories.map((c: any) => c.name);
    expect(klhNames).toContain(klhCat.body.name);
    expect(klhNames).not.toContain(drkCat.body.name);

    const drkMenu = await request(server).get("/menu?school=DRK");
    expect(drkMenu.status).toBe(200);
    const drkNames = drkMenu.body.categories.map((c: any) => c.name);
    expect(drkNames).toContain(drkCat.body.name);
    expect(drkNames).not.toContain(klhCat.body.name);
  });

  it("blocks a DRK admin from bulk-updating a KLH category's items", async () => {
    const klhToken = await makeAdminToken("KLH");
    const drkToken = await makeAdminToken("DRK");

    const catRes = await request(server)
      .post("/admin/categories")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ name: "KLH Bulk", sortOrder: 1 });

    const bulkRes = await request(server)
      .patch(`/admin/categories/${catRes.body.id}/bulk-items`)
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ isAvailable: false });

    expect(bulkRes.status).toBe(403);
  });
});
