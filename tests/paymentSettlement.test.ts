import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import { computeWebhookSignature, releaseUnpaidOrders } from "../src/services/paymentService.js";
import { sql, query } from "../src/db/sql.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";

/**
 * Settlement, end to end, without the gateway.
 *
 * The one thing VyaparGateway is needed for is `create_order` — obtaining a
 * QR. Everything that happens AFTER the money moves is ours, and it is the
 * part that actually releases food, so it is proved here by signing webhooks
 * with the test secret and posting them at the real endpoint.
 *
 * What that covers: an unpaid order stays invisible to the kitchen, a valid
 * webhook confirms it, a replay changes nothing, a tampered amount is refused,
 * a failure hands the stock back, and a forged signature is rejected outright.
 */

/**
 * Payments on, for this file only.
 *
 * The suite's default is off, matching the shape production ships in, so that
 * every other test exercises the ordinary no-payment flow. Set before the
 * server is constructed below, because paymentsEnabled() is read per request
 * from these same bindings.
 */
process.env.PAYMENTS_ENABLED = "true";

const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

/** Matches VYAPAR_WEBHOOK_SECRET in .env.test — deliberately not the real one. */
const WEBHOOK_SECRET = "whsec_test_secret_not_real_do_not_use";

async function makeStudent() {
  return userRepo.insert(pool, {
    role: "STUDENT",
    rollNumber: `R${Date.now()}${Math.floor(Math.random() * 1000)}`,
    email: `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}@klh.edu.in`,
    passwordHash: await bcrypt.hash("x", 4),
    name: "Payer",
    school: "KLH",
  });
}

async function makeItem(stockQty = 10, price = "15.00") {
  const category = await categoryRepo.insertCategory(pool, {
    name: `Cat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    sortOrder: 1,
    kitchen: "SNACKS",
  });
  return menuItemRepo.insertMenuItem(pool, {
    name: "Samosa",
    imageUrl: "https://example.test/s.jpg",
    price,
    stockQty,
    categoryId: category.id,
  });
}

/**
 * An order sitting exactly where checkout leaves it: written, holding stock,
 * attached to a PENDING payment, and hidden from the kitchen.
 *
 * Built directly rather than through POST /payments/checkout because that
 * route calls the gateway — the one step this suite exists to work around.
 * Every column it sets is one initiatePayment would have set.
 */
async function seedAwaitingPayment(options: { qty?: number; amount?: string; price?: string } = {}) {
  const qty = options.qty ?? 2;
  const price = options.price ?? "15.00";
  const amount = options.amount ?? (Number(price) * qty).toFixed(2);

  const student = await makeStudent();
  const item = await makeItem(10, price);

  const paymentId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const clientTxnId = `KLHTEST${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  await query(
    pool,
    sql`
      INSERT INTO "Payment" ("id","clientTxnId","gatewayOrderId","amount","currency","status","studentId","expiresAt","createdAt","updatedAt")
      VALUES (${paymentId}::text, ${clientTxnId}::text, ${`gw-${clientTxnId}`}::text, ${amount}::numeric,
              'INR','PENDING', ${student.id}::text, NOW() + INTERVAL '2 minutes', NOW(), NOW())
    `,
  );

  // Reserve the stock, exactly as createOrder's claim does.
  await query(
    pool,
    sql`UPDATE "MenuItem" SET "reservedQty" = "reservedQty" + ${qty}::int WHERE "id" = ${item.id}::text`,
  );

  await query(
    pool,
    sql`
      INSERT INTO "Order" ("id","studentId","kitchen","token","orderNumber","totalAmount",
                           "reservedAt","reservationExpiresAt","paymentId","awaitingPayment","status")
      VALUES (${orderId}::text, ${student.id}::text, 'SNACKS', ${crypto.randomUUID()}::text,
              ${1000 + Math.floor(Math.random() * 8000)}::int, ${amount}::numeric,
              NOW(), NOW() + INTERVAL '4 hours', ${paymentId}::text, TRUE, 'PENDING')
    `,
  );
  await query(
    pool,
    sql`
      INSERT INTO "OrderItem" ("id","orderId","menuItemId","quantity","priceAtOrder")
      VALUES (${crypto.randomUUID()}::text, ${orderId}::text, ${item.id}::text, ${qty}::int, ${price}::numeric)
    `,
  );

  return { student, item, paymentId, orderId, clientTxnId, amount, qty };
}

/** Posts a webhook signed the way the gateway signs one: over the raw bytes. */
async function postWebhook(payload: Record<string, unknown>, options: { secret?: string; timestamp?: string } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = await computeWebhookSignature(options.secret ?? WEBHOOK_SECRET, timestamp, body);

  return request(server)
    .post("/payments/webhook")
    .set("Content-Type", "application/json")
    .set("X-VyaparGateway-Signature", signature)
    .set("X-VyaparGateway-Timestamp", timestamp)
    .send(body);
}

async function readOrder(orderId: string) {
  const { rows } = await query<{ status: string; awaitingPayment: boolean; stockSettledAt: Date | null }>(
    pool,
    sql`SELECT "status","awaitingPayment","stockSettledAt" FROM "Order" WHERE "id" = ${orderId}::text`,
  );
  return rows[0];
}

async function readPayment(paymentId: string) {
  const { rows } = await query<{ status: string; upiTxnId: string | null; paidAt: Date | null; webhookCount: number }>(
    pool,
    sql`SELECT "status","upiTxnId","paidAt","webhookCount" FROM "Payment" WHERE "id" = ${paymentId}::text`,
  );
  return rows[0];
}

async function readReserved(menuItemId: string) {
  const { rows } = await query<{ reservedQty: number }>(
    pool,
    sql`SELECT "reservedQty" FROM "MenuItem" WHERE "id" = ${menuItemId}::text`,
  );
  return rows[0].reservedQty;
}

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await closeTestServer(server);
  await disconnectTestPrisma();
});

describeDb("payment settlement", () => {
  it("keeps an unpaid order off the kitchen board while holding its stock", async () => {
    const { orderId, item, qty } = await seedAwaitingPayment();

    const order = await readOrder(orderId);
    expect(order.awaitingPayment).toBe(true);
    // The portions ARE held — that is what stops the cart selling out from
    // under a student mid-payment.
    expect(await readReserved(item.id)).toBe(qty);

    // And the board cannot see it.
    const { rows } = await query<{ id: string }>(
      pool,
      sql`SELECT "id" FROM "Order" WHERE "awaitingPayment" = FALSE`,
    );
    expect(rows).toHaveLength(0);
  });

  it("confirms the order on a valid payment.success", async () => {
    const { orderId, paymentId, clientTxnId, amount, item, qty } = await seedAwaitingPayment();

    const res = await postWebhook({
      event: "payment.success",
      status: "success",
      client_txn_id: clientTxnId,
      amount: Number(amount),
      upi_txn_id: "403993715517",
      payer_vpa: "student@upi",
      idempotency_key: "idem-success-1",
      timestamp: Math.floor(Date.now() / 1000),
    });

    expect(res.status).toBe(200);

    const order = await readOrder(orderId);
    // Visible to the kitchen, and still PENDING — the status every existing
    // board query and transition already understands as a new order.
    expect(order.awaitingPayment).toBe(false);
    expect(order.status).toBe("PENDING");
    // The reservation survives; it is settled at delivery, not at payment.
    expect(order.stockSettledAt).toBeNull();
    expect(await readReserved(item.id)).toBe(qty);

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe("SUCCESS");
    expect(payment.upiTxnId).toBe("403993715517");
    expect(payment.paidAt).not.toBeNull();
  });

  it("treats a replayed delivery as a no-op", async () => {
    const { orderId, paymentId, clientTxnId, amount, item, qty } = await seedAwaitingPayment();

    const payload = {
      event: "payment.success",
      status: "success",
      client_txn_id: clientTxnId,
      amount: Number(amount),
      upi_txn_id: "403993715517",
      idempotency_key: "idem-replay-1",
    };

    const first = await postWebhook(payload);
    const second = await postWebhook(payload);

    // Both answered 200: the retry is expected traffic, not an error.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const order = await readOrder(orderId);
    expect(order.awaitingPayment).toBe(false);
    expect(order.status).toBe("PENDING");
    // The replay must not have moved stock a second time.
    expect(await readReserved(item.id)).toBe(qty);

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe("SUCCESS");
    // Counted once — the duplicate was refused before it could increment.
    expect(payment.webhookCount).toBe(1);
  });

  it("refuses a success whose amount does not match, and releases the order", async () => {
    const { orderId, paymentId, clientTxnId, item } = await seedAwaitingPayment({ qty: 2, price: "15.00" });

    // Signed correctly, but claiming ₹1 against a ₹30 order.
    const res = await postWebhook({
      event: "payment.success",
      status: "success",
      client_txn_id: clientTxnId,
      amount: 1,
      upi_txn_id: "wrong-amount",
      idempotency_key: "idem-mismatch-1",
    });

    expect(res.status).toBe(200);

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe("FAILED");

    // No food released, and the portions went back on sale.
    const order = await readOrder(orderId);
    expect(order.status).toBe("CANCELLED");
    expect(order.awaitingPayment).toBe(false);
    expect(await readReserved(item.id)).toBe(0);
  });

  it("cancels the order and returns stock on payment.failed", async () => {
    const { orderId, paymentId, clientTxnId, item } = await seedAwaitingPayment();

    const res = await postWebhook({
      event: "payment.failed",
      status: "failed",
      client_txn_id: clientTxnId,
      idempotency_key: "idem-failed-1",
    });

    expect(res.status).toBe(200);
    expect((await readPayment(paymentId)).status).toBe("FAILED");

    const order = await readOrder(orderId);
    expect(order.status).toBe("CANCELLED");
    expect(order.awaitingPayment).toBe(false);
    // The give-back that a RETURNING-based gate silently skipped.
    expect(await readReserved(item.id)).toBe(0);
    expect(order.stockSettledAt).not.toBeNull();
  });

  it("does not un-confirm an order when a late failure arrives after success", async () => {
    const { orderId, paymentId, clientTxnId, amount, item, qty } = await seedAwaitingPayment();

    await postWebhook({
      event: "payment.success",
      status: "success",
      client_txn_id: clientTxnId,
      amount: Number(amount),
      idempotency_key: "idem-first-success",
    });
    // A contradicting delivery, correctly signed, arriving afterwards.
    await postWebhook({
      event: "payment.failed",
      status: "failed",
      client_txn_id: clientTxnId,
      idempotency_key: "idem-late-failure",
    });

    // Terminal states are final: the kitchen may already be cooking this.
    const payment = await readPayment(paymentId);
    expect(payment.status).toBe("SUCCESS");

    const order = await readOrder(orderId);
    expect(order.status).toBe("PENDING");
    expect(order.awaitingPayment).toBe(false);
    expect(await readReserved(item.id)).toBe(qty);
  });

  it("rejects a forged signature and changes nothing", async () => {
    const { orderId, paymentId, clientTxnId, amount, item, qty } = await seedAwaitingPayment();

    const res = await postWebhook(
      {
        event: "payment.success",
        status: "success",
        client_txn_id: clientTxnId,
        amount: Number(amount),
        idempotency_key: "idem-forged",
      },
      { secret: "whsec_attacker_guessed_this" },
    );

    expect(res.status).toBe(401);

    // The order stayed hidden. This is the test that matters most: without
    // signature verification, this request alone would have released food.
    const order = await readOrder(orderId);
    expect(order.awaitingPayment).toBe(true);
    expect(order.status).toBe("PENDING");
    expect((await readPayment(paymentId)).status).toBe("PENDING");
    expect(await readReserved(item.id)).toBe(qty);
  });

  it("rejects a replayed-but-stale timestamp even with a valid signature", async () => {
    const { orderId, clientTxnId, amount } = await seedAwaitingPayment();

    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await postWebhook(
      {
        event: "payment.success",
        status: "success",
        client_txn_id: clientTxnId,
        amount: Number(amount),
        idempotency_key: "idem-stale",
      },
      { timestamp: stale },
    );

    expect(res.status).toBe(401);
    expect((await readOrder(orderId)).awaitingPayment).toBe(true);
  });

  /**
   * The regression this file originally missed.
   *
   * Every other test here seeds an awaiting-payment order directly, so all of
   * them passed while POST /orders was still writing `awaitingPayment = FALSE`
   * — it never passed the flag to createOrder. Checkout then refused those
   * orders with ORDERS_NOT_PAYABLE (409) and no test noticed, because nothing
   * exercised the route that actually creates them.
   */
  it("marks an order awaiting payment when placed through POST /orders", async () => {
    const student = await makeStudent();
    const item = await makeItem(10, "20.00");
    const token = signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ menuItemId: item.id, qty: 2 }] });

    expect(res.status).toBe(201);
    const [created] = res.body;

    // Written, holding stock, and hidden — the state checkout requires.
    const order = await readOrder(created.id);
    expect(order.awaitingPayment).toBe(true);
    expect(order.status).toBe("PENDING");
    expect(await readReserved(item.id)).toBe(2);

    // And therefore genuinely payable: the checkout query's own predicate.
    const { rows: payable } = await query<{ id: string }>(
      pool,
      sql`
        SELECT "id" FROM "Order"
         WHERE "id" = ${created.id}::text
           AND "awaitingPayment" = TRUE
           AND "paymentId" IS NULL
           AND "status" = 'PENDING'
           AND "studentId" = ${student.id}::text
      `,
    );
    expect(payable).toHaveLength(1);
  });

  /**
   * Checkout writes the orders before calling the gateway, so a gateway failure
   * would otherwise leave them reserved and invisible for the full four-hour
   * TTL — food off sale over something the student cannot fix.
   */
  it("releases orders and their stock when no payment was ever opened", async () => {
    const student = await makeStudent();
    const item = await makeItem(10, "20.00");
    const token = signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const res = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ menuItemId: item.id, qty: 3 }] });
    const orderId = res.body[0].id;
    expect(await readReserved(item.id)).toBe(3);

    const released = await releaseUnpaidOrders(pool, [orderId]);
    expect(released).toEqual([orderId]);

    const order = await readOrder(orderId);
    expect(order.status).toBe("CANCELLED");
    expect(order.awaitingPayment).toBe(false);
    expect(await readReserved(item.id)).toBe(0);
  });

  it("refuses to release an order whose payment is genuinely open", async () => {
    // The guard that keeps a failed checkout from cancelling somebody else's
    // in-flight payment: only orders with NO paymentId may be released.
    const { orderId, item, qty } = await seedAwaitingPayment();

    const released = await releaseUnpaidOrders(pool, [orderId]);
    expect(released).toEqual([]);

    const order = await readOrder(orderId);
    expect(order.status).toBe("PENDING");
    expect(order.awaitingPayment).toBe(true);
    expect(await readReserved(item.id)).toBe(qty);
  });

  it("ignores a webhook naming a payment we have no record of", async () => {
    const res = await postWebhook({
      event: "payment.success",
      status: "success",
      client_txn_id: "KLH-never-issued-this",
      amount: 99,
      idempotency_key: "idem-unknown",
    });

    // 200, because the delivery was genuine and there is nothing to retry.
    expect(res.status).toBe(200);
  });
});
