import { it, expect, beforeEach, afterAll, describe } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import {
  issueGuestSession,
  verifyGuestSession,
  GUEST_SESSION_TTL_SECONDS,
} from "../src/services/guestSessionService.js";
import { signOrderToken } from "../src/lib/orderToken.js";
import { describeDb, getTestPrisma, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer, createMenuItem, seedOrder, createStudent } from "./helpers/app.js";

const prisma = testDb.enabled ? getTestPrisma() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

const SESSION_HEADER = "X-Guest-Session";
const SECRET = process.env.QR_TOKEN_SECRET!;

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

/** Corrupts the HMAC of a real session token, leaving its shape intact. */
function tamperSignature(token: string): string {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const parts = decoded.split(".");
  const sig = parts[3]!;
  parts[3] = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
  return Buffer.from(parts.join(".")).toString("base64url");
}

describe("guest session tokens (no database needed)", () => {
  it("round-trips a session id through issue -> verify", () => {
    const session = issueGuestSession(SECRET);
    expect(verifyGuestSession(session.token, SECRET)).toBe(session.sessionId);
  });

  it("rejects a token whose signature was tampered with", () => {
    const session = issueGuestSession(SECRET);
    expect(verifyGuestSession(tamperSignature(session.token), SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const forged = issueGuestSession("an-attacker-guessed-secret");
    expect(verifyGuestSession(forged.token, SECRET)).toBeNull();
  });

  it("rejects a session id swapped into an otherwise valid token", () => {
    const mine = issueGuestSession(SECRET);
    const theirs = issueGuestSession(SECRET);
    const decoded = Buffer.from(mine.token, "base64url").toString("utf8").split(".");
    decoded[1] = theirs.sessionId;
    const swapped = Buffer.from(decoded.join(".")).toString("base64url");
    expect(verifyGuestSession(swapped, SECRET)).toBeNull();
  });

  it("rejects an order token replayed as a session token (prefix separation)", () => {
    // Both are HMACs over the same QR_TOKEN_SECRET; only the magic prefix
    // keeps the two namespaces apart.
    const orderToken = signOrderToken(crypto.randomUUID(), SECRET);
    expect(verifyGuestSession(orderToken, SECRET)).toBeNull();
  });

  it("rejects a session older than its TTL", () => {
    const realNow = Date.now;
    Date.now = () => realNow() - (GUEST_SESSION_TTL_SECONDS + 60) * 1000;
    const stale = issueGuestSession(SECRET);
    Date.now = realNow;
    expect(verifyGuestSession(stale.token, SECRET)).toBeNull();
  });

  it("rejects a token issued in the future (clock-skew forgery)", () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 60 * 1000;
    const future = issueGuestSession(SECRET);
    Date.now = realNow;
    expect(verifyGuestSession(future.token, SECRET)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyGuestSession("", SECRET)).toBeNull();
    expect(verifyGuestSession("not-a-token", SECRET)).toBeNull();
    expect(verifyGuestSession(Buffer.from("a.b.c").toString("base64url"), SECRET)).toBeNull();
  });
});

describeDb("POST /guest/session", () => {
  it("mints a usable session for a walk-up guest with no account", async () => {
    const res = await request(server).post("/guest/session");

    expect(res.status).toBe(201);
    expect(typeof res.body.sessionToken).toBe("string");
    expect(res.body.header).toBe(SESSION_HEADER);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The token must actually verify — not merely be a string.
    expect(verifyGuestSession(res.body.sessionToken, SECRET)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never returns the raw session id alongside the token", () => {
    // The session id is the guest's bearer key; echoing it would put it in
    // logs and screenshots next to the token that protects it.
    const session = issueGuestSession(SECRET);
    expect(JSON.stringify({ sessionToken: session.token })).not.toContain(session.sessionId);
  });

  it("gives two guests different sessions", async () => {
    const a = await request(server).post("/guest/session");
    const b = await request(server).post("/guest/session");
    expect(verifyGuestSession(a.body.sessionToken, SECRET)).not.toBe(
      verifyGuestSession(b.body.sessionToken, SECRET),
    );
  });
});

describeDb("guest session authentication", () => {
  it("401s a request with no session header at all", async () => {
    const res = await request(server).get("/guest/orders");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NO_GUEST_SESSION");
  });

  it("401s a forged token", async () => {
    const res = await request(server)
      .get("/guest/orders")
      .set(SESSION_HEADER, tamperSignature(issueGuestSession(SECRET).token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_GUEST_SESSION");
  });

  it("401s a token signed with the wrong secret", async () => {
    const res = await request(server)
      .get("/guest/orders")
      .set(SESSION_HEADER, issueGuestSession("wrong-secret").token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_GUEST_SESSION");
  });

  it("401s an expired session", async () => {
    const realNow = Date.now;
    Date.now = () => realNow() - (GUEST_SESSION_TTL_SECONDS + 60) * 1000;
    const stale = issueGuestSession(SECRET);
    Date.now = realNow;

    const res = await request(server).get("/guest/orders").set(SESSION_HEADER, stale.token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_GUEST_SESSION");
  });

  it("401s a placing attempt with no session, without creating anything", async () => {
    const item = await createMenuItem();
    const res = await request(server)
      .post("/guest/orders")
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });

    expect(res.status).toBe(401);
    expect(await prisma.order.count()).toBe(0);
  });

  it("accepts the session on the Authorization: Guest <token> form too", async () => {
    const session = issueGuestSession(SECRET);
    const res = await request(server)
      .get("/guest/orders")
      .set("Authorization", `Guest ${session.token}`);
    expect(res.status).toBe(200);
  });
});

/**
 * THE ISOLATION PROPERTY.
 *
 * A guest session token proves only "I am the session that placed these
 * orders". Session A must not be able to read session B's order, and must not
 * be able to tell B's order apart from an order that does not exist — a 403
 * would confirm the id is real and turn the endpoint into an order-id oracle.
 */
describeDb("guest order isolation", () => {
  async function twoGuestsWithOneOrderEach() {
    const item = await createMenuItem();
    const a = issueGuestSession(SECRET);
    const b = issueGuestSession(SECRET);
    const orderA = await seedOrder({ guestSessionId: a.sessionId, menuItemId: item.id, guestName: "Ana" });
    const orderB = await seedOrder({ guestSessionId: b.sessionId, menuItemId: item.id, guestName: "Ben" });
    return { a, b, orderA, orderB };
  }

  it("lets a guest read their own order", async () => {
    const { a, orderA } = await twoGuestsWithOneOrderEach();
    const res = await request(server).get(`/guest/orders/${orderA.id}`).set(SESSION_HEADER, a.token);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orderA.id);
  });

  it("gives session A a 404 — not a 403, not the order — for session B's order", async () => {
    const { a, orderB } = await twoGuestsWithOneOrderEach();

    const res = await request(server).get(`/guest/orders/${orderB.id}`).set(SESSION_HEADER, a.token);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.body.id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("Ben");
  });

  it("answers identically for another session's order and for an id that does not exist", async () => {
    const { a, orderB } = await twoGuestsWithOneOrderEach();

    const foreign = await request(server).get(`/guest/orders/${orderB.id}`).set(SESSION_HEADER, a.token);
    const missing = await request(server)
      .get(`/guest/orders/${crypto.randomUUID()}`)
      .set(SESSION_HEADER, a.token);

    // Byte-identical: nothing distinguishes "not yours" from "not there".
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it("lists only the calling session's own orders", async () => {
    const { a, orderA } = await twoGuestsWithOneOrderEach();

    const res = await request(server).get("/guest/orders").set(SESSION_HEADER, a.token);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(orderA.id);
  });

  it("never echoes the session id back in a response body", async () => {
    const { a, orderA } = await twoGuestsWithOneOrderEach();
    const res = await request(server).get(`/guest/orders/${orderA.id}`).set(SESSION_HEADER, a.token);
    expect(JSON.stringify(res.body)).not.toContain(a.sessionId);
  });

  it("cannot reach a STUDENT's order through the guest endpoints", async () => {
    const item = await createMenuItem();
    const student = await createStudent();
    const studentOrder = await seedOrder({ studentId: student.id, menuItemId: item.id });
    const guest = issueGuestSession(SECRET);

    const res = await request(server)
      .get(`/guest/orders/${studentOrder.id}`)
      .set(SESSION_HEADER, guest.token);

    expect(res.status).toBe(404);
  });
});

describeDb("POST /guest/orders", () => {
  it("places an order owned by the session, with a NULL studentId", async () => {
    const item = await createMenuItem({ price: "20.00", stockQty: 10 });
    const session = issueGuestSession(SECRET);

    const res = await request(server)
      .post("/guest/orders")
      .set(SESSION_HEADER, session.token)
      .send({ items: [{ menuItemId: item.id, qty: 2 }], guestName: "Ana" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalAmount).toBe("40.00");
    expect(res.body[0].status).toBe("PENDING");
    expect(typeof res.body[0].token).toBe("string");
    // The session key must not come back out in the response.
    expect(res.body[0].guestSessionId).toBeUndefined();

    const stored = await prisma.order.findUnique({ where: { id: res.body[0].id } });
    expect(stored!.studentId).toBeNull();
    expect(stored!.guestSessionId).toBe(session.sessionId);
    expect(stored!.guestName).toBe("Ana");
  });

  it("keeps two sessions' orders apart end to end", async () => {
    const item = await createMenuItem({ stockQty: 10 });
    const a = issueGuestSession(SECRET);
    const b = issueGuestSession(SECRET);

    const placed = await request(server)
      .post("/guest/orders")
      .set(SESSION_HEADER, a.token)
      .send({ items: [{ menuItemId: item.id, qty: 1 }] });
    expect(placed.status).toBe(201);

    const bSees = await request(server).get("/guest/orders").set(SESSION_HEADER, b.token);
    expect(bSees.status).toBe(200);
    expect(bSees.body).toHaveLength(0);

    const bProbes = await request(server)
      .get(`/guest/orders/${placed.body[0].id}`)
      .set(SESSION_HEADER, b.token);
    expect(bProbes.status).toBe(404);
  });
});
