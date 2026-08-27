import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * `env(c)` from hono/adapter returns `process.env` under Node and `c.env` only
 * on workerd, so a Durable Object binding can never be injected from a Node
 * test without this. Merging process.env keeps DATABASE_URL/JWT_SECRET working
 * exactly as they do everywhere else; the only addition is the binding the
 * Workers runtime would have supplied.
 *
 * This is the ONE substitution in this file. The middleware, the routes, the
 * auth service and the database are all real.
 */
vi.mock("hono/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono/adapter")>();
  return {
    ...actual,
    env: (c: any) => ({ ...process.env, ...(c?.env ?? {}) }),
  };
});

const { createApp } = await import("../src/app.js");
const { issueGuestSession } = await import("../src/services/guestSessionService.js");
const { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } = await import(
  "./helpers/db.js"
);
const { createStudent, createMenuItem, TEST_PASSWORD } = await import("./helpers/app.js");
const { FakeRateLimiterHub } = await import("./helpers/fakeRateLimiterHub.js");
const { sql, query } = await import("../src/db/sql.js");

const pool = testDb.enabled ? getTestPool() : (undefined as any);
const app = createApp();

let hub: InstanceType<typeof FakeRateLimiterHub>;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  // app.fetch is typed as sync-or-async; normalise so callers can always await.
  return Promise.resolve(
    app.fetch(
      new Request(`http://test.local${path}`, init),
      { RATE_LIMITER_HUB: hub.namespace } as any,
      { waitUntil() {}, passThroughOnException() {} } as any,
    ),
  );
}

function login(identifier: string, password: string) {
  return call("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password, school: "KLH" }),
  });
}

beforeEach(async () => {
  hub = new FakeRateLimiterHub();
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (testDb.enabled) await disconnectTestPrisma();
});

describeDb("login rate limiting: THE NO-LOCKOUT PROPERTY", () => {
  /**
   * Login is keyed on the submitted campus ID, which anyone can type. If that
   * limit could ever REFUSE a request, anybody could disable any student's
   * account by posting their roll number with wrong passwords. There must be
   * no attempt count at which the correct password stops working.
   */
  it("still accepts the correct password after 10 wrong ones for the same identity", async () => {
    const student = await createStudent({ rollNumber: "2420090001" });

    for (let i = 0; i < 10; i++) {
      const wrong = await login(student.rollNumber!, `guess-${i}`);
      expect(wrong.status).toBe(401);
      // A 429 here is the lockout this design exists to prevent.
      expect(wrong.status).not.toBe(429);
    }

    const right = await login(student.rollNumber!, TEST_PASSWORD);

    expect(right.status).toBe(200);
    const body = (await right.json()) as { token?: string };
    expect(typeof body.token).toBe("string");
  }, 60_000);

  it("never returns 429 from login, however many attempts are made", async () => {
    const student = await createStudent({ rollNumber: "2420090002" });
    const statuses: number[] = [];

    for (let i = 0; i < 8; i++) {
      statuses.push((await login(student.rollNumber!, "nope")).status);
    }

    expect(statuses).not.toContain(429);
    expect(new Set(statuses)).toEqual(new Set([401]));
  }, 60_000);

  it("one student's failed attempts never affect another student", async () => {
    const victim = await createStudent({ rollNumber: "2420090003" });
    const bystander = await createStudent({ rollNumber: "2420090004" });

    for (let i = 0; i < 8; i++) {
      await login(victim.rollNumber!, "attacker-guess");
    }

    const bystanderLogin = await login(bystander.rollNumber!, TEST_PASSWORD);
    expect(bystanderLogin.status).toBe(200);

    // Structurally: the two identities addressed two different counters, and
    // the bystander's was never touched by the attack.
    expect(hub.counterFor("login:id:2420090003", "login")!.count).toBe(8);
    // The bystander's own counter is separate, and their success cleared it —
    // at no point did the attack put attempts on the bystander's bucket.
    expect(hub.counterFor("login:id:2420090004", "login")).toBeUndefined();
    // Two hits on the bystander's object — their own /consume and the /reset
    // that followed their success. None of the attacker's 8 landed there.
    expect(hub.addressed.filter((n) => n === "login:id:2420090004")).toHaveLength(2);
    expect(hub.addressed.filter((n) => n === "login:id:2420090003")).toHaveLength(8);
  }, 60_000);

  it("keys the counter on the submitted identity, never on anything network-derived", async () => {
    const student = await createStudent({ rollNumber: "2420090005" });

    // Same "client", two different identities: two counters, not one.
    await login(student.rollNumber!, "wrong");
    await login("2420090999", "wrong");

    expect(hub.addressed).toContain("login:id:2420090005");
    expect(hub.addressed).toContain("login:id:2420090999");
    expect(hub.counterFor("login:id:2420090005", "login")!.count).toBe(1);
  }, 60_000);

  it("normalises the identity so case and whitespace cannot split a counter", async () => {
    const student = await createStudent({ email: "asha@klh.edu.in" });

    await login("asha@klh.edu.in", "wrong");
    await login("  ASHA@KLH.EDU.IN  ", "wrong");

    expect(hub.counterFor("login:id:asha@klh.edu.in", "login")!.count).toBe(2);
  }, 60_000);

  it("clears the counter after a successful login, so a fumbled password costs nothing later", async () => {
    const student = await createStudent({ rollNumber: "2420090006" });

    await login(student.rollNumber!, "typo");
    await login(student.rollNumber!, "typo again");
    expect(hub.counterFor("login:id:2420090006", "login")!.count).toBe(2);

    const ok = await login(student.rollNumber!, TEST_PASSWORD);
    expect(ok.status).toBe(200);

    expect(hub.counterFor("login:id:2420090006", "login")).toBeUndefined();
  }, 60_000);
});

describeDb('the "reject" strategy still rejects where the key cannot be forged', () => {
  /**
   * The counterpart to the property above: where the key IS unforgeable (a
   * verified guest session), exceeding the limit must actually return 429 —
   * otherwise "progressive delay everywhere" would leave the app with no
   * enforceable limit at all.
   */
  it("429s the 6th guest order in a minute and leaves other sessions untouched", async () => {
    const item = await createMenuItem({ stockQty: 500 });
    const session = issueGuestSession(process.env.QR_TOKEN_SECRET!);
    const other = issueGuestSession(process.env.QR_TOKEN_SECRET!);

    const place = (token: string) =>
      call("/guest/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Session": token },
        body: JSON.stringify({ items: [{ menuItemId: item.id, qty: 1 }] }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await place(session.token)).status);

    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);

    // A different session has its own bucket and is unaffected.
    expect((await place(other.token)).status).toBe(201);

    // Exactly the orders that were accepted exist.
    const { rows } = await query<{ count: string }>(pool, sql`SELECT COUNT(*)::bigint AS count FROM "Order"`);
    expect(Number(rows[0].count)).toBe(6);
  }, 60_000);
});

describe("anonymous traffic is not limited by network address", () => {
  /**
   * The whole campus shares one NATed WiFi address. An IP-keyed limit would
   * throttle hundreds of students at once, so there is deliberately no IP
   * fallback: a request with no derivable identity is not limited here at all
   * (that is the edge/WAF's job). The global limit is 100/minute, so 150
   * anonymous requests getting through is the evidence.
   */
  it("lets 150 anonymous requests through a 100/minute global limit", async () => {
    hub = new FakeRateLimiterHub();
    const statuses = new Set<number>();
    for (let i = 0; i < 150; i++) statuses.add((await call("/health")).status);

    expect(statuses).toEqual(new Set([200]));
    // Nothing was counted, because there was nothing to count it against.
    expect(hub.addressed).toHaveLength(0);
  });

  it("gives two authenticated users separate global buckets", async () => {
    if (!testDb.enabled) return;
    const a = await createStudent();
    const b = await createStudent();
    const { signToken } = await import("../src/lib/jwt.js");
    const tokenA = signToken({ sub: a.id, role: "STUDENT" }, process.env.JWT_SECRET!);
    const tokenB = signToken({ sub: b.id, role: "STUDENT" }, process.env.JWT_SECRET!);

    await call("/orders/my", { headers: { Authorization: `Bearer ${tokenA}` } });
    await call("/orders/my", { headers: { Authorization: `Bearer ${tokenB}` } });

    expect(hub.counterFor(`global:u:${a.id}`, "global")!.count).toBe(1);
    expect(hub.counterFor(`global:u:${b.id}`, "global")!.count).toBe(1);
  });
});
