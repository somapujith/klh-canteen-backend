import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const app = createApp();

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

describe("POST /auth/login", () => {
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

    const res = await request(app)
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

    const res = await request(app)
      .post("/auth/login")
      .send({ identifier: "student1@klh.edu.in", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.stack).toBeUndefined();
  });
});
