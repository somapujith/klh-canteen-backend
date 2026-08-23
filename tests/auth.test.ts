import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

import { describeDb, getTestPrisma, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const prisma = testDb.enabled ? getTestPrisma() : (undefined as any);
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
    await prisma.user.create({
      data: {
        role: "ADMIN",
        email: "admin@klh.edu.in",
        passwordHash,
        name: "Admin One",
      },
    });

    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "admin@klh.edu.in", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("ADMIN");
    expect(typeof res.body.token).toBe("string");
  });

  it("rejects wrong password with 401 and no stack trace", async () => {
    const passwordHash = await bcrypt.hash("secret123", 12);
    await prisma.user.create({
      data: {
        role: "STUDENT",
        rollNumber: "23BCE001",
        email: "student1@klh.edu.in",
        passwordHash,
        name: "Student One",
      },
    });

    const res = await request(server)
      .post("/auth/login")
      .send({ identifier: "student1@klh.edu.in", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.stack).toBeUndefined();
  });
});
