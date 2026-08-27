/**
 * App + fixtures for HTTP-level tests.
 *
 * The app is a Hono instance (app.fetch), so supertest cannot bind to it
 * directly; @hono/node-server adapts it onto a real http.Server. We resolve on
 * the "listening" callback because serve() returns before the socket is bound.
 */
import crypto from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app.js";
import { signToken } from "../../src/lib/jwt.js";
import { sql, query } from "../../src/db/sql.js";
import * as userRepo from "../../src/db/userRepo.js";
import * as categoryRepo from "../../src/db/categoryRepo.js";
import * as menuItemRepo from "../../src/db/menuItemRepo.js";
import type { Order, OrderItem } from "../../src/db/schema.js";
import { getTestPool } from "./db.js";

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
  const student = await userRepo.insert(getTestPool(), {
    role: "STUDENT",
    name: overrides.name ?? "Test Student",
    rollNumber: overrides.rollNumber ?? uid("R"),
    email: overrides.email ?? `${uid("student")}@klh.edu.in`,
    passwordHash: await bcrypt.hash(password, 4),
    school: "KLH",
  });
  return { ...student, password };
}

export async function createAdmin(
  overrides: Partial<{ name: string; email: string; password: string; kitchen: "SNACKS" | "MEALS" }> = {},
) {
  const password = overrides.password ?? TEST_PASSWORD;
  const admin = await userRepo.insert(getTestPool(), {
    role: "ADMIN",
    name: overrides.name ?? "Test Admin",
    email: overrides.email ?? `${uid("admin")}@klh.edu.in`,
    passwordHash: await bcrypt.hash(password, 4),
    kitchen: overrides.kitchen ?? null,
    school: "KLH",
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
  const pool = getTestPool();
  const category = await categoryRepo.insertCategory(pool, {
    name: uid("Category"),
    sortOrder: 1,
    kitchen: options.kitchen ?? "SNACKS",
  });
  return menuItemRepo.insertMenuItem(pool, {
    name: options.name ?? "Samosa",
    imageUrl: "https://example.com/samosa.jpg",
    price: options.price ?? "20.00",
    stockQty: options.stockQty ?? 100,
    categoryId: category.id,
  });
}

/**
 * Inserts an Order row directly.
 *
 * Used by tests whose subject is a READ path — guest isolation, the admin
 * board's pagination and its handling of guest orders. Going through
 * POST /orders would drag stock reservation, kitchen splitting and token signing
 * into tests that are not about any of those, and would make a failure in any
 * of them look like a pagination bug.
 *
 * Tests whose subject IS order creation go through the HTTP API instead.
 *
 * A plain two-statement insert (Order, then its one OrderItem) rather than
 * orderService.ts's batch-insert machinery — a fixture only ever writes one
 * row at a time, so the single-row shape is simpler and clearer here.
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
  const pool = getTestPool();
  const qty = options.qty ?? 1;
  const price = options.price ?? "20.00";
  const orderId = crypto.randomUUID();
  const itemId = crypto.randomUUID();

  const { rows: orderRows } = await query<Order>(
    pool,
    sql`
      INSERT INTO "Order" (
        "id", "studentId", "guestSessionId", "guestName", "guestPhone",
        "status", "kitchen", "token", "orderNumber", "totalAmount",
        "createdAt", "collectionAt"
      )
      VALUES (
        ${orderId}, ${options.studentId ?? null}, ${options.guestSessionId ?? null},
        ${options.guestName ?? null}, ${options.guestPhone ?? null},
        ${(options.status ?? "PENDING")}::"OrderStatus", ${(options.kitchen ?? "SNACKS")}::"Kitchen",
        ${uid("order-token")}, ${1000 + (unique % 8000)}, ${(Number(price) * qty).toFixed(2)},
        ${options.createdAt ? options.createdAt.toISOString() : new Date().toISOString()}::timestamp,
        ${options.collectionAt ? options.collectionAt.toISOString() : null}::timestamp
      )
      RETURNING *
    `,
  );
  const order = orderRows[0];

  const { rows: itemRows } = await query<OrderItem>(
    pool,
    sql`
      INSERT INTO "OrderItem" ("id", "orderId", "menuItemId", "quantity", "priceAtOrder")
      VALUES (${itemId}, ${orderId}, ${options.menuItemId}, ${qty}, ${price})
      RETURNING *
    `,
  );

  return { ...order, items: itemRows };
}
