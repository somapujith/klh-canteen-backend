import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../src/lib/jwt.js";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer } from "./helpers/app.js";
import { releaseUnpaidOrders } from "../src/services/paymentService.js";
import { sql, query } from "../src/db/sql.js";
import * as userRepo from "../src/db/userRepo.js";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";

/**
 * Settlement, end to end, without a live merchant.
 *
 * SafeUPI is needed only to obtain a payment link. Everything that happens
 * after the money moves is ours, and it is the half that actually releases
 * food, so it is proved here by posting webhooks at the real endpoint with
 * SafeUPI's Status API stubbed.
 *
 * BOTH sides are controlled on purpose. SafeUPI's webhook is unsigned, so the
 * delivery alone is only a claim; applyWebhook confirms it against the Status
 * API before releasing anything. Several tests below make the two disagree,
 * because that disagreement is the forged-webhook case.
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

/** Matches SAFEUPI_WEBHOOK_SECRET in .env.test — deliberately not real. */
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

/**
 * What SafeUPI's Status API will claim on the next call.
 *
 * applyWebhook confirms every settlement against that endpoint before it
 * releases anything, so these tests must control BOTH sides: the delivery, and
 * the gateway's own answer. That is the point — a webhook alone proves nothing
 * here, which is precisely the property being tested.
 */
let gatewayTruth:
  | { status: string; amount: string | number; utr?: string | null; vpa?: string | null }
  | null = null;
/** Set to make the Status API call fail, as an unreachable gateway would. */
let gatewayUnreachable = false;

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    if (url.includes("safeupi.com/api/order/status")) {
      if (gatewayUnreachable) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!gatewayTruth) {
        return new Response(JSON.stringify({ success: false, message: "Order not found" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          message: "Order status retrieved successfully",
          data: {
            id: 1,
            system_order_id: `SU-${body.merchant_order_id}`,
            merchant_order_id: body.merchant_order_id,
            status: gatewayTruth.status,
            amount: String(gatewayTruth.amount),
            payment: {
              // `?? default` would override an explicit null, which is exactly
              // the case the disagreement test needs: a gateway that reports no
              // UTR at all.
              utr: "utr" in gatewayTruth ? gatewayTruth.utr : "100852466451",
              customer_vpa: "vpa" in gatewayTruth ? gatewayTruth.vpa : "student@upi",
            },
          },
        }),
        { status: 200 },
      );
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * Posts a webhook the way SafeUPI does: a plain JSON body carrying the shared
 * secret. There is no signature to compute — that is the whole reason the
 * Status API confirmation exists.
 */
async function postWebhook(
  payload: Record<string, unknown>,
  options: { secret?: string } = {},
) {
  return request(server)
    .post("/payments/webhook")
    .set("Content-Type", "application/json")
    .send({ ...payload, secret: options.secret ?? WEBHOOK_SECRET });
}

/** A SafeUPI webhook body for one payment. */
function webhookBody(event: string, clientTxnId: string, extra: Record<string, unknown> = {}) {
  return {
    event,
    data: {
      status: event,
      merchant_order_id: clientTxnId,
      system_order_id: `SU-${clientTxnId}`,
      ...extra,
    },
  };
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

    gatewayTruth = { status: "success", amount, utr: "403993715517" };
    const res = await postWebhook(webhookBody("success", clientTxnId));

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

    gatewayTruth = { status: "success", amount, utr: "403993715517" };
    const payload = webhookBody("success", clientTxnId);

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

    // The gateway itself reports ₹1 against a ₹30 order.
    gatewayTruth = { status: "success", amount: "1.00", utr: "wrong-amount" };
    const res = await postWebhook(webhookBody("success", clientTxnId));

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

    gatewayTruth = { status: "failed", amount: "0.00", utr: null };
    const res = await postWebhook(webhookBody("failed", clientTxnId));

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

    gatewayTruth = { status: "success", amount, utr: "403993715517" };
    await postWebhook(webhookBody("success", clientTxnId));

    // A contradicting delivery arriving afterwards, which the gateway now
    // agrees with. Even so it must not un-confirm a cooking order.
    gatewayTruth = { status: "failed", amount, utr: null };
    await postWebhook(webhookBody("failed", clientTxnId));

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

    gatewayTruth = { status: "success", amount, utr: "403993715517" };
    const res = await postWebhook(webhookBody("success", clientTxnId), {
      secret: "whsec_attacker_guessed_this",
    });

    expect(res.status).toBe(401);

    // The order stayed hidden. This is the test that matters most: without
    // signature verification, this request alone would have released food.
    const order = await readOrder(orderId);
    expect(order.awaitingPayment).toBe(true);
    expect(order.status).toBe("PENDING");
    expect((await readPayment(paymentId)).status).toBe("PENDING");
    expect(await readReserved(item.id)).toBe(qty);
  });

  /**
   * The defence that replaces signature verification.
   *
   * An attacker who learns the shared secret — from a log, a proxy, anywhere a
   * webhook body has ever been written down — can send a perfectly
   * authenticated "success". This is that attack, and it fails: the Status API
   * still says pending, so nothing is released.
   */
  it("releases nothing when the gateway disagrees with a well-formed webhook", async () => {
    const { orderId, paymentId, clientTxnId, item, qty } = await seedAwaitingPayment();

    // SafeUPI itself says the money never arrived.
    gatewayTruth = { status: "pending", amount: "30.00" };
    const res = await postWebhook(webhookBody("success", clientTxnId));

    // 200, because the delivery was well-formed; but nothing moved.
    expect(res.status).toBe(200);

    const order = await readOrder(orderId);
    expect(order.awaitingPayment).toBe(true);
    expect(order.status).toBe("PENDING");
    expect((await readPayment(paymentId)).status).toBe("PENDING");
    expect(await readReserved(item.id)).toBe(qty);
  });

  /**
   * Found by probing the real endpoint: the forged webhook was correctly
   * refused, but its fabricated UTR was still written to the payment row,
   * because the write fell back to the payload when the gateway had no UTR of
   * its own. Nothing was released, so it looked fine — while quietly poisoning
   * the fields a later dispute is read from.
   */
  it("stores no attacker-supplied data from a webhook the gateway disagrees with", async () => {
    const { paymentId, clientTxnId } = await seedAwaitingPayment();

    gatewayTruth = { status: "pending", amount: "30.00", utr: null, vpa: null };
    await postWebhook(
      webhookBody("success", clientTxnId, {
        payment: { utr: "999888777666", customer_vpa: "attacker@upi" },
        customer_name: "Attacker",
      }),
    );

    const { rows } = await query<{
      upiTxnId: string | null;
      payerVpa: string | null;
      idempotencyKey: string | null;
    }>(
      pool,
      sql`SELECT "upiTxnId","payerVpa","idempotencyKey" FROM "Payment" WHERE "id" = ${paymentId}::text`,
    );
    expect(rows[0].upiTxnId).toBeNull();
    expect(rows[0].payerVpa).toBeNull();
    // The replay key must not be attacker-chosen either: it decides whether a
    // later genuine delivery is mistaken for a duplicate and ignored.
    expect(rows[0].idempotencyKey).toBeNull();
  });

  it("releases nothing when the gateway cannot be reached", async () => {
    const { orderId, paymentId, clientTxnId, item, qty } = await seedAwaitingPayment();

    // Unverifiable is treated as untrue: the poll and the expiry sweep both
    // still run, so a genuine payment is picked up moments later anyway.
    gatewayUnreachable = true;
    const res = await postWebhook(webhookBody("success", clientTxnId));
    gatewayUnreachable = false;

    expect(res.status).toBe(200);
    expect((await readOrder(orderId)).awaitingPayment).toBe(true);
    expect((await readPayment(paymentId)).status).toBe("PENDING");
    expect(await readReserved(item.id)).toBe(qty);
  });

  it("records that a settlement was confirmed against the Status API", async () => {
    const { paymentId, clientTxnId, amount } = await seedAwaitingPayment();

    gatewayTruth = { status: "success", amount, utr: "403993715517" };
    await postWebhook(webhookBody("success", clientTxnId));

    const { rows } = await query<{ verifiedViaStatusApi: boolean }>(
      pool,
      sql`SELECT "verifiedViaStatusApi" FROM "Payment" WHERE "id" = ${paymentId}::text`,
    );
    expect(rows[0].verifiedViaStatusApi).toBe(true);
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

  /**
   * Found in the browser as a 502 at checkout.
   *
   * User.email doubles as the login identifier, and most student accounts hold
   * a bare username there — a roll number, usually — rather than an address.
   * Forwarding one to SafeUPI earned `422 Valid customer email is required`,
   * so the majority of students could not pay at all.
   */
  it("does not send a non-address login identifier to the gateway as an email", async () => {
    const student = await userRepo.insert(pool, {
      role: "STUDENT",
      rollNumber: null,
      // Exactly the shape the live rows have: a roll number in the email column.
      email: `24200${Math.floor(Math.random() * 1e5)}`,
      passwordHash: await bcrypt.hash("x", 4),
      name: "Username Only",
      school: "KLH",
    });
    const item = await makeItem(10, "20.00");
    const token = signToken({ sub: student.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    const placed = await request(server)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });
    expect(placed.status).toBe(201);

    let sentEmail: string | undefined;
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? "");
      if (url.includes("safeupi.com/api/order/create")) {
        sentEmail = JSON.parse(String(init?.body ?? "{}")).customer_email;
        return new Response(
          JSON.stringify({
            success: true,
            message: "Order created successfully",
            data: {
              id: 1,
              system_order_id: "AP-test",
              merchant_order_id: "x",
              payment: { url: "https://www.safeupi.com/api/gateway/pay?id=test" },
            },
          }),
          { status: 200 },
        );
      }
      return previous(input, init);
    }) as typeof globalThis.fetch;

    const res = await request(server)
      .post("/payments/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderIds: [placed.body[0].id] });
    globalThis.fetch = previous;

    expect(res.status).toBe(201);
    // A real address or the generated placeholder — never the raw identifier.
    expect(sentEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(sentEmail).not.toBe(student.email);
  });

  it("ignores a webhook naming a payment we have no record of", async () => {
    gatewayTruth = { status: "success", amount: "99.00" };
    const res = await postWebhook(webhookBody("success", "KLH-never-issued-this"));

    // 200, because the delivery was genuine and there is nothing to retry.
    expect(res.status).toBe(200);
  });
});
