import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

async function makeStudent() {
  const passwordHash = await bcrypt.hash("x", 12);
  return userRepo.insert(pool, {
    role: "STUDENT",
    rollNumber: `R${Date.now()}`,
    email: `s-${Date.now()}@klh.edu.in`,
    passwordHash,
    name: "S",
    school: "KLH",
  });
}

async function makeItem(stockQty = 10) {
  const category = await categoryRepo.insertCategory(pool, { name: `Cat-${Date.now()}`, sortOrder: 1, kitchen: "SNACKS" });
  return menuItemRepo.insertMenuItem(pool, {
    name: "Tea",
    imageUrl: "https://x.com/tea.jpg",
    price: "10.00",
    stockQty,
    categoryId: category.id,
  });
}

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

describeDb("POST /orders", () => {
  it("creates an order with a signed token, without touching stock yet", async () => {
    const student = await makeStudent();
    const item = await makeItem(10);
    const token = signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ menuItemId: item.id, qty: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body[0].status).toBe("PENDING");
    expect(res.body[0].totalAmount).toBe("20.00");
    // The opaque row key is not part of the client contract.
    expect(res.body[0].token).toBeUndefined();

    const unchangedItem = await menuItemRepo.findMenuItemById(pool, item.id);
    expect(unchangedItem?.stockQty).toBe(10);
  });

  it("lists only the requesting student's own orders", async () => {
    const studentA = await makeStudent();
    const studentB = await makeStudent();
    const item = await makeItem(10);
    const tokenA = signToken({ sub: studentA.id, role: "STUDENT" }, process.env.JWT_SECRET!);
    const tokenB = signToken({ sub: studentB.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    await request(server).post("/orders").set("Authorization", `Bearer ${tokenA}`).send({ items: [{ menuItemId: item.id, qty: 1 }] });
    await request(server).post("/orders").set("Authorization", `Bearer ${tokenB}`).send({ items: [{ menuItemId: item.id, qty: 1 }] });

    const res = await request(server).get("/orders/my").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
