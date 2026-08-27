import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import * as userRepo from "../src/db/userRepo.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

describeDb("POST /auth/login", () => {
  it("logs in a valid admin and returns a JWT", async () => {
    const passwordHash = await bcrypt.hash("secret123", 12);
    await userRepo.insert(pool, {
      role: "ADMIN",
      email: "admin@klh.edu.in",
      passwordHash,
      name: "Admin One",
      school: "KLH",
    });

    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "admin@klh.edu.in", password: "secret123", school: "KLH" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("ADMIN");
    expect(typeof res.body.token).toBe("string");
  });

  it("rejects wrong password with 401 and no stack trace", async () => {
    const passwordHash = await bcrypt.hash("secret123", 12);
    await userRepo.insert(pool, {
      role: "STUDENT",
      rollNumber: "23BCE001",
      email: "student1@klh.edu.in",
      passwordHash,
      name: "Student One",
      school: "KLH",
    });

    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "student1@klh.edu.in", password: "wrong", school: "KLH" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.stack).toBeUndefined();
  });

  it("rejects a correct password submitted against the wrong school, with the same generic message", async () => {
    const passwordHash = await bcrypt.hash("secret123", 12);
    await userRepo.insert(pool, {
      role: "STUDENT",
      rollNumber: "23BCE002",
      email: "student2@klh.edu.in",
      passwordHash,
      name: "Student Two",
      school: "KLH",
    });

    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "student2@klh.edu.in", password: "secret123", school: "DRK" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(res.body.error.message).toMatch(/invalid credentials/i);
  });

  it("logs a DRK user in when DRK is picked, and still refuses them under KLH", async () => {
    const passwordHash = await bcrypt.hash("secret123", 12);
    await userRepo.insert(pool, {
      role: "STUDENT",
      rollNumber: "23DRK001",
      email: "student1@drk.edu.in",
      passwordHash,
      name: "DRK Student",
      school: "DRK",
    });

    const wrongSchool = await request(server)
      .post("/auth/login")
      .send({ identifier: "student1@drk.edu.in", password: "secret123", school: "KLH" });
    expect(wrongSchool.status).toBe(401);

    const rightSchool = await request(server)
      .post("/auth/login")
      .send({ identifier: "student1@drk.edu.in", password: "secret123", school: "DRK" });
    expect(rightSchool.status).toBe(200);
    expect(rightSchool.body.role).toBe("STUDENT");
  });

  it("rejects a request missing the school field with a 400", async () => {
    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "admin@klh.edu.in", password: "secret123" });

    expect(res.status).toBe(400);
  });
});
