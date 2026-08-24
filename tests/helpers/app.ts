/**
 * App + fixtures for HTTP-level tests.
 *
 * The app is a Hono instance (app.fetch), so supertest cannot bind to it
 * directly; @hono/node-server adapts it onto a real http.Server. We resolve on
 * the "listening" callback because serve() returns before the socket is bound.
 */
import { serve, type ServerType } from "@hono/node-server";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app.js";
import { signToken } from "../../src/lib/jwt.js";
import { getTestPrisma } from "./db.js";

export function startTestServer(): Promise<ServerType> {
  const app = createApp();
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, () => resolve(server));
  });
}

export function closeTestServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let unique = 0;
function uid(prefix: string): string {
  unique += 1;
  return `${prefix}-${Date.now().toString(36)}-${unique}`;
}

export const TEST_PASSWORD = "correct-horse-battery";

export async function createStudent(
  overrides: Partial<{ name: string; rollNumber: string; email: string; password: string }> = {},
) {
  const password = overrides.password ?? TEST_PASSWORD;
  const student = await getTestPrisma().user.create({
    data: {
      role: "STUDENT",
      name: overrides.name ?? "Test Student",
      rollNumber: overrides.rollNumber ?? uid("R"),
      email: overrides.email ?? `${uid("student")}@klh.edu.in`,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  return { ...student, password };
}

export async function createAdmin(
  overrides: Partial<{ name: string; email: string; password: string; kitchen: "SNACKS" | "MEALS" }> = {},
) {
  const password = overrides.password ?? TEST_PASSWORD;
  const admin = await getTestPrisma().user.create({
    data: {
      role: "ADMIN",
      name: overrides.name ?? "Test Admin",
      email: overrides.email ?? `${uid("admin")}@klh.edu.in`,
      passwordHash: await bcrypt.hash(password, 4),
      ...(overrides.kitchen ? { kitchen: overrides.kitchen } : {}),
    },
  });
  return { ...admin, password };
}

export function tokenFor(user: { id: string; role: string; kitchen?: string | null }): string {
  return signToken(
    { sub: user.id, role: user.role as any, kitchen: user.kitchen ?? null },
    process.env.JWT_SECRET!,
  );
}

export async function createMenuItem(
  options: Partial<{ price: string; stockQty: number; kitchen: "SNACKS" | "MEALS"; name: string }> = {},
) {
  const prisma = getTestPrisma();
  const category = await prisma.category.create({
    data: { name: uid("Category"), sortOrder: 1, kitchen: options.kitchen ?? "SNACKS" },
  });
  return prisma.menuItem.create({
    data: {
      name: options.name ?? "Samosa",
      imageUrl: "https://example.com/samosa.jpg",
      price: options.price ?? "20.00",
      stockQty: options.stockQty ?? 100,
      categoryId: category.id,
    },
  });
}

/**
 * Inserts an Order row directly.
 *
 * Used by tests whose subject is a READ path — guest isolation, the admin
 * board's pagination and its handling of guest orders. Going through
 * POST /orders would drag stock reservation, kitchen splitting and QR signing
 * into tests that are not about any of those, and would make a failure in any
 * of them look like a pagination bug.
 *
 * Tests whose subject IS order creation go through the HTTP API instead.
 */
export async function seedOrder(options: {
  studentId?: string | null;
  guestSessionId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  menuItemId: string;
  qty?: number;
  price?: string;
  status?: "PENDING" | "PREPARING" | "COOKED" | "DELIVERED";
  kitchen?: "SNACKS" | "MEALS";
  createdAt?: Date;
  collectionAt?: Date | null;
}) {
  const qty = options.qty ?? 1;
  const price = options.price ?? "20.00";
  return getTestPrisma().order.create({
    data: {
      studentId: options.studentId ?? null,
      guestSessionId: options.guestSessionId ?? null,
      guestName: options.guestName ?? null,
      guestPhone: options.guestPhone ?? null,
      status: options.status ?? "PENDING",
      kitchen: options.kitchen ?? "SNACKS",
      token: uid("order-token"),
      orderNumber: 1000 + (unique % 8000),
      totalAmount: (Number(price) * qty).toFixed(2),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      collectionAt: options.collectionAt ?? null,
      items: { create: [{ menuItemId: options.menuItemId, quantity: qty, priceAtOrder: price }] },
    },
    include: { items: true },
  });
}
