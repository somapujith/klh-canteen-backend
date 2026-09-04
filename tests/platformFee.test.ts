import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";
import { setPlatformFeePercent, getPlatformFeePercent } from "../src/db/schoolSettingsRepo.js";
import type { School } from "../src/db/schema.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

async function makeStudent(school: School) {
  const passwordHash = await bcrypt.hash("x", 12);
  return userRepo.insert(pool, {
    role: "STUDENT",
    rollNumber: `R${Date.now()}-${Math.random()}`,
    email: `s-${Date.now()}-${Math.random()}@klh.edu.in`,
    passwordHash,
    name: "S",
    school,
  });
}

async function makeSuperAdmin() {
  const passwordHash = await bcrypt.hash("x", 12);
  const admin = await userRepo.insert(pool, {
    role: "SUPERADMIN",
    email: `superadmin-${Date.now()}-${Math.random()}@klh.edu.in`,
    passwordHash,
    name: "SA",
    school: "KLH",
  });
  return { id: admin.id, token: signToken({ sub: admin.id, role: "SUPERADMIN" }, process.env.JWT_SECRET!) };
}

async function makeAdmin() {
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

async function makeItem(price: string, stockQty = 10) {
  const category = await categoryRepo.insertCategory(pool, {
    name: `Cat-${Date.now()}-${Math.random()}`,
    sortOrder: 1,
    kitchen: "SNACKS",
  });
  return menuItemRepo.insertMenuItem(pool, {
    name: "Tea",
    imageUrl: "https://x.com/tea.jpg",
    price,
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

describeDb("platform fee", () => {
  it("defaults to 0% for a school with no SchoolSettings row", async () => {
    expect(await getPlatformFeePercent(pool, "KLH")).toBe(0);
    expect(await getPlatformFeePercent(pool, "DRK")).toBe(0);
  });

  it("applies KLH's fee % to a KLH student's order while leaving DRK unset at 0%", async () => {
    await setPlatformFeePercent(pool, "KLH", 5);

    const klhStudent = await makeStudent("KLH");
    const drkStudent = await makeStudent("DRK");
    // 10.00 x 3 = 30.00 subtotal for both carts.
    const item = await makeItem("10.00");

    const klhToken = signToken({ sub: klhStudent.id, role: "STUDENT" }, process.env.JWT_SECRET!);
    const drkToken = signToken({ sub: drkStudent.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const klhRes = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${klhToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 3 }] });

    expect(klhRes.status).toBe(201);
    // subtotal 30.00 * 1.05 = 31.50, fee = 30.00 * 0.05 = 1.50
    expect(klhRes.body[0].platformFeeAmount).toBe("1.50");
    expect(klhRes.body[0].totalAmount).toBe("31.50");
    expect(klhRes.body[0].school).toBe("KLH");

    const drkRes = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${drkToken}`)
      .send({ items: [{ menuItemId: item.id, qty: 3 }] });

    expect(drkRes.status).toBe(201);
    // DRK's fee was never set -> defaults to 0%, completely unaffected.
    expect(drkRes.body[0].platformFeeAmount).toBe("0.00");
    expect(drkRes.body[0].totalAmount).toBe("30.00");
    expect(drkRes.body[0].school).toBe("DRK");
  });

  it("leaves an order's total unchanged when no fee has ever been set (byte-identical to pre-fee behaviour)", async () => {
    const student = await makeStudent("KLH");
    const item = await makeItem("10.00");
    const token = signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ menuItemId: item.id, qty: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body[0].totalAmount).toBe("20.00");
    expect(res.body[0].platformFeeAmount).toBe("0.00");
  });
});

describeDb("GET/PATCH /superadmin/settings/platform-fee", () => {
  it("returns both schools at 0% before either fee is ever set", async () => {
    const { token } = await makeSuperAdmin();

    const res = await request(server).get("/superadmin/settings/platform-fee").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const feeBySchool = Object.fromEntries(res.body.fees.map((f: any) => [f.school, f.platformFeePercent]));
    expect(feeBySchool).toEqual({ KLH: 0, DRK: 0 });
    expect(res.body.stats).toHaveLength(2);
    const statsBySchool = Object.fromEntries(res.body.stats.map((s: any) => [s.school, s]));
    expect(statsBySchool.KLH.totalOrdersToday).toBe(0);
    expect(statsBySchool.DRK.totalOrdersToday).toBe(0);
  });

  it("updates one school's fee without affecting the other", async () => {
    const { token } = await makeSuperAdmin();

    const patchRes = await request(server)
      .patch("/superadmin/settings/platform-fee/KLH")
      .set("Authorization", `Bearer ${token}`)
      .send({ percent: 7.5 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual({ school: "KLH", platformFeePercent: 7.5 });

    const getRes = await request(server).get("/superadmin/settings/platform-fee").set("Authorization", `Bearer ${token}`);
    const feeBySchool = Object.fromEntries(getRes.body.fees.map((f: any) => [f.school, f.platformFeePercent]));
    expect(feeBySchool).toEqual({ KLH: 7.5, DRK: 0 });
  });

  it("rejects a non-superadmin with 403", async () => {
    const { token } = await makeAdmin();

    const getRes = await request(server).get("/superadmin/settings/platform-fee").set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(403);

    const patchRes = await request(server)
      .patch("/superadmin/settings/platform-fee/KLH")
      .set("Authorization", `Bearer ${token}`)
      .send({ percent: 10 });
    expect(patchRes.status).toBe(403);
  });

  it("rejects a percent outside 0-100", async () => {
    const { token } = await makeSuperAdmin();

    const res = await request(server)
      .patch("/superadmin/settings/platform-fee/KLH")
      .set("Authorization", `Bearer ${token}`)
      .send({ percent: 150 });

    expect(res.status).toBe(400);
  });
});
