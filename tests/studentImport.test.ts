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

describe("POST /admin/students/bulk", () => {
  it("creates students from valid CSV rows and reports duplicates", async () => {
    const token = await makeAdminToken();
    const csv = [
      "name,rollNumber,email,password",
      "Asha Rao,23BCE001,asha@klh.edu.in,pass1234",
      "Bilal Khan,23BCE002,bilal@klh.edu.in,pass1234",
      "Asha Rao,23BCE001,asha@klh.edu.in,pass1234",
    ].join("\n");

    const res = await request(app)
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
});
