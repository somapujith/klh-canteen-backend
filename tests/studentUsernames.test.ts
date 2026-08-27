/**
 * Student usernames are the bare roll number.
 *
 * Three things have to hold at once, and the middle one is the whole reason
 * this file exists:
 *   1. newly created students are stored WITHOUT the `@klh.edu.in` suffix,
 *   2. students stored either way can log in typing either form, so the
 *      backfill can run whenever and nobody is locked out in between,
 *   3. staff addresses are untouched by any of it.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";
import { importStudentRoster } from "../src/services/studentRosterService.js";
import {
  previewStudentUsernameBackfill,
  applyStudentUsernameBackfill,
} from "../src/services/studentUsernameBackfill.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import * as userRepo from "../src/db/userRepo.js";
import { sql, query } from "../src/db/sql.js";
import type { User } from "../src/db/schema.js";

const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

const ROSTER_PASSWORD = "roster-pass-9182";

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

function login(identifier: string, password: string) {
  return request(server).post("/auth/login").send({ identifier, password, school: "KLH" });
}

/** A student stored the OLD way — `email` still carries the synthetic suffix. */
async function seedLegacyStudent(rollNumber: string, password: string) {
  return userRepo.insert(pool, {
    role: "STUDENT",
    name: "Legacy Student",
    rollNumber,
    email: `${rollNumber.toLowerCase()}@klh.edu.in`,
    passwordHash: await bcrypt.hash(password, 4),
    school: "KLH",
  });
}

async function countStudentsByRole(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    pool,
    sql`SELECT COUNT(*)::bigint AS count FROM "User" WHERE "role" = 'STUDENT'::"Role"`,
  );
  return Number(rows[0].count);
}

async function countAdminsByRole(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    pool,
    sql`SELECT COUNT(*)::bigint AS count FROM "User" WHERE "role" = 'ADMIN'::"Role"`,
  );
  return Number(rows[0].count);
}

async function countUsersWithAtSign(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    pool,
    sql`SELECT COUNT(*)::bigint AS count FROM "User" WHERE "email" LIKE '%@%'`,
  );
  return Number(rows[0].count);
}

async function findUsersByRoleOrdered(role: "STUDENT"): Promise<Pick<User, "rollNumber" | "email">[]> {
  const { rows } = await query<Pick<User, "rollNumber" | "email">>(
    pool,
    sql`SELECT "rollNumber", "email" FROM "User" WHERE "role" = ${role}::"Role" ORDER BY "rollNumber" ASC`,
  );
  return rows;
}

async function findUserByEmail(email: string): Promise<Pick<User, "id" | "role"> | null> {
  const { rows } = await query<Pick<User, "id" | "role">>(
    pool,
    sql`SELECT "id", "role" FROM "User" WHERE "email" = ${email} LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function findUserByRollNumber(rollNumber: string): Promise<Pick<User, "email"> | null> {
  const { rows } = await query<Pick<User, "email">>(
    pool,
    sql`SELECT "email" FROM "User" WHERE "rollNumber" = ${rollNumber} LIMIT 1`,
  );
  return rows[0] ?? null;
}

describeDb("student usernames — creation", () => {
  it("stores the bare roll number as the username on a roster import", async () => {
    const csv = ["name,rollNumber", "Asha Rao,2420090001", "Bilal Khan,2420090002"].join("\n");

    const summary = await importStudentRoster(pool, csv, ROSTER_PASSWORD);
    expect(summary.created).toBe(2);

    const students = await findUsersByRoleOrdered("STUDENT");

    expect(students).toEqual([
      { rollNumber: "2420090001", email: "2420090001" },
      { rollNumber: "2420090002", email: "2420090002" },
    ]);
    // The regression this file was written for: no synthetic domain anywhere.
    expect(students.every((s: { email: string }) => !s.email.includes("@"))).toBe(true);
  });

  it("still reports a re-uploaded roster as already existing after the change", async () => {
    const csv = ["name,rollNumber", "Asha Rao,2420090001"].join("\n");
    await importStudentRoster(pool, csv, ROSTER_PASSWORD);

    const second = await importStudentRoster(pool, csv, ROSTER_PASSWORD);
    expect(second.created).toBe(0);
    expect(second.results[0]).toMatchObject({ status: "skipped", reason: "already exists" });
    expect(await countStudentsByRole()).toBe(1);
  });

  it("recognises a student still stored in the legacy form, so a re-upload does not duplicate them", async () => {
    await seedLegacyStudent("2420090003", ROSTER_PASSWORD);

    const csv = ["name,rollNumber", "Old Student,2420090003"].join("\n");
    const summary = await importStudentRoster(pool, csv, ROSTER_PASSWORD);

    expect(summary.created).toBe(0);
    expect(summary.results[0]).toMatchObject({ status: "skipped", reason: "already exists" });
    expect(await countStudentsByRole()).toBe(1);
  });

  it("derives the username from rollNumber when a superadmin adds one student without an email", async () => {
    const superadmin = await userRepo.insert(pool, {
      role: "SUPERADMIN",
      name: "Super",
      email: "superadmin@klh.edu.in",
      passwordHash: await bcrypt.hash("x", 4),
      school: "KLH",
    });
    const token = signToken({ sub: superadmin.id, role: "SUPERADMIN" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/superadmin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "STUDENT", name: "Chitra", rollNumber: "2420090004", password: "hunter2hunter2", school: "KLH" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("2420090004");
  });

  it("still demands a real address for a staff account", async () => {
    const superadmin = await userRepo.insert(pool, {
      role: "SUPERADMIN",
      name: "Super",
      email: "superadmin@klh.edu.in",
      passwordHash: await bcrypt.hash("x", 4),
      school: "KLH",
    });
    const token = signToken({ sub: superadmin.id, role: "SUPERADMIN" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/superadmin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "ADMIN", name: "Kitchen", password: "hunter2hunter2", kitchen: "SNACKS" });

    expect(res.status).toBe(400);
    expect(await countAdminsByRole()).toBe(0);
  });
});

describeDb("student usernames — login accepts both forms", () => {
  it("logs a newly imported student in by their bare roll number", async () => {
    await importStudentRoster(pool, "name,rollNumber\nAsha,2420090001", ROSTER_PASSWORD);

    const res = await login("2420090001", ROSTER_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("STUDENT");
  });

  it("logs a newly imported student in by the OLD full address they still have saved", async () => {
    await importStudentRoster(pool, "name,rollNumber\nAsha,2420090001", ROSTER_PASSWORD);

    const res = await login("2420090001@klh.edu.in", ROSTER_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("STUDENT");
  });

  it("logs a NOT-YET-backfilled student in by either form", async () => {
    await seedLegacyStudent("2420090005", ROSTER_PASSWORD);

    expect((await login("2420090005@klh.edu.in", ROSTER_PASSWORD)).status).toBe(200);
    expect((await login("2420090005", ROSTER_PASSWORD)).status).toBe(200);
  });

  it("tolerates surrounding whitespace and casing on the legacy form", async () => {
    await importStudentRoster(pool, "name,rollNumber\nAsha,23BCE001", ROSTER_PASSWORD);

    const res = await login("  23bce001@KLH.EDU.IN  ", ROSTER_PASSWORD);
    expect(res.status).toBe(200);
  });

  it("still rejects a wrong password submitted in the legacy form", async () => {
    await importStudentRoster(pool, "name,rollNumber\nAsha,2420090001", ROSTER_PASSWORD);

    const res = await login("2420090001@klh.edu.in", "not-the-password");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("does not let the domain-stripping fallback reach a non-student account", async () => {
    // `superadmin@klh.edu.in` strips to `superadmin`. If the fallback were not
    // scoped to STUDENT, this decoy would be a free alias for the real
    // superadmin login — a privilege escalation, not a convenience.
    await userRepo.insert(pool, {
      role: "STUDENT",
      name: "Decoy",
      rollNumber: "superadmin",
      email: "decoy-username",
      passwordHash: await bcrypt.hash("decoy-password-1", 4),
      school: "KLH",
    });
    const real = await userRepo.insert(pool, {
      role: "SUPERADMIN",
      name: "Super",
      email: "superadmin@klh.edu.in",
      passwordHash: await bcrypt.hash("real-password-1", 4),
      school: "KLH",
    });

    // The staff address resolves to the staff account, exactly as before.
    const staff = await login("superadmin@klh.edu.in", "real-password-1");
    expect(staff.status).toBe(200);
    expect(staff.body.id).toBe(real.id);
    expect(staff.body.role).toBe("SUPERADMIN");

    // And the decoy's own password does NOT open that address.
    expect((await login("superadmin@klh.edu.in", "decoy-password-1")).status).toBe(401);
  });

  it("leaves a staff account with a real address logging in normally", async () => {
    await userRepo.insert(pool, {
      role: "ADMIN",
      name: "Snacks Admin",
      email: "snacks_admin@klh.edu.in",
      kitchen: "SNACKS",
      passwordHash: await bcrypt.hash("admin-password-1", 4),
      school: "KLH",
    });

    const res = await login("snacks_admin@klh.edu.in", "admin-password-1");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("ADMIN");
  });
});

describeDb("student usernames — backfill", () => {
  it("converts legacy student rows and leaves staff and hand-typed addresses alone", async () => {
    await seedLegacyStudent("2420090010", ROSTER_PASSWORD);
    await seedLegacyStudent("2420090011", ROSTER_PASSWORD);
    // The demo/load-test account: its email is not derived from its roll
    // number, and PROTECTED_ACCOUNT_EMAILS matches it BY EMAIL.
    await userRepo.insert(pool, {
      role: "STUDENT",
      name: "Demo Student",
      rollNumber: "2400000001",
      email: "student@klh.edu.in",
      passwordHash: await bcrypt.hash("x", 4),
      school: "KLH",
    });
    await userRepo.insert(pool, {
      role: "SUPERADMIN",
      name: "Super",
      email: "superadmin@klh.edu.in",
      passwordHash: await bcrypt.hash("x", 4),
      school: "KLH",
    });

    const preview = await previewStudentUsernameBackfill(pool);
    expect(preview.convertible.map((r) => r.email).sort()).toEqual([
      "2420090010@klh.edu.in",
      "2420090011@klh.edu.in",
    ]);
    expect(preview.blocked).toHaveLength(0);

    // A preview writes nothing.
    expect(await countUsersWithAtSign()).toBe(4);

    expect(await applyStudentUsernameBackfill(pool)).toBe(2);

    const byRoll = async (rollNumber: string) => (await findUserByRollNumber(rollNumber))!.email;

    expect(await byRoll("2420090010")).toBe("2420090010");
    expect(await byRoll("2420090011")).toBe("2420090011");
    expect(await byRoll("2400000001")).toBe("student@klh.edu.in");
    expect((await findUserByEmail("superadmin@klh.edu.in"))!.role).toBe("SUPERADMIN");
  });

  it("is idempotent — a second run changes nothing", async () => {
    await seedLegacyStudent("2420090020", ROSTER_PASSWORD);

    expect(await applyStudentUsernameBackfill(pool)).toBe(1);
    expect(await applyStudentUsernameBackfill(pool)).toBe(0);

    const preview = await previewStudentUsernameBackfill(pool);
    expect(preview.convertible).toHaveLength(0);
    expect(preview.alreadyBare).toBe(1);
  });

  it("skips a row whose bare username is already taken instead of crashing on the unique index", async () => {
    await seedLegacyStudent("2420090030", ROSTER_PASSWORD);
    // Somebody already occupies the target username.
    await userRepo.insert(pool, {
      role: "STUDENT",
      name: "Squatter",
      rollNumber: "squatter-roll",
      email: "2420090030",
      passwordHash: await bcrypt.hash("x", 4),
      school: "KLH",
    });

    const preview = await previewStudentUsernameBackfill(pool);
    expect(preview.convertible).toHaveLength(0);
    expect(preview.blocked.map((r) => r.email)).toEqual(["2420090030@klh.edu.in"]);

    expect(await applyStudentUsernameBackfill(pool)).toBe(0);

    // The blocked student is untouched, and still authenticates.
    const res = await login("2420090030@klh.edu.in", ROSTER_PASSWORD);
    expect(res.status).toBe(200);
  });

  it("leaves every backfilled student able to log in with the address they had before", async () => {
    await seedLegacyStudent("2420090040", ROSTER_PASSWORD);
    await applyStudentUsernameBackfill(pool);

    expect((await login("2420090040@klh.edu.in", ROSTER_PASSWORD)).status).toBe(200);
    expect((await login("2420090040", ROSTER_PASSWORD)).status).toBe(200);
  });
});
