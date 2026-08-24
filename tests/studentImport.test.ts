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

// Role is read from the database row, not the token (middleware/auth.ts), so
// the row is what decides whether the gate opens — signing the token with the
// same role just keeps the fixture honest.
async function makeToken(role: "ADMIN" | "SUPERADMIN") {
  const passwordHash = await bcrypt.hash("x", 12);
  const user = await prisma.user.create({
    data: {
      role,
      email: `${role.toLowerCase()}-${Date.now()}-${Math.random()}@klh.edu.in`,
      passwordHash,
      name: "A",
    },
  });
  return signToken({ sub: user.id, role }, process.env.JWT_SECRET!);
}

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

describeDb("POST /admin/students/bulk", () => {
  it("creates students from valid CSV rows and reports duplicates", async () => {
    const token = await makeToken("SUPERADMIN");
    const csv = [
      "name,rollNumber,email,password",
      "Asha Rao,23BCE001,asha@klh.edu.in,pass1234",
      "Bilal Khan,23BCE002,bilal@klh.edu.in,pass1234",
      "Asha Rao,23BCE001,asha@klh.edu.in,pass1234",
    ].join("\n");

    const res = await request(server)
      .post("/admin/students/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].status).toBe("created");
    expect(res.body.results[1].status).toBe("created");
    expect(res.body.results[2].status).toBe("skipped");

    const count = await prisma.user.count({ where: { role: "STUDENT" } });
    expect(count).toBe(2);
  });

  // Student management moved to SUPERADMIN-only. A plain ADMIN reaching this
  // route is the regression this guards: the row must not be created and the
  // request must be rejected, not silently no-op.
  it("rejects a plain ADMIN with 403 and imports nothing", async () => {
    const token = await makeToken("ADMIN");
    const csv = ["name,rollNumber,email,password", "Asha Rao,23BCE001,asha@klh.edu.in,pass1234"].join("\n");

    const res = await request(server)
      .post("/admin/students/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ csv });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await prisma.user.count({ where: { role: "STUDENT" } })).toBe(0);
  });

  it("allows a SUPERADMIN to import", async () => {
    const token = await makeToken("SUPERADMIN");
    const csv = ["name,rollNumber,email,password", "Asha Rao,23BCE001,asha@klh.edu.in,pass1234"].join("\n");

    const res = await request(server)
      .post("/admin/students/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("created");
    expect(await prisma.user.count({ where: { role: "STUDENT" } })).toBe(1);
  });
});
