/**
 * Sustained concurrent load against a DEPLOYED environment, over HTTPS.
 *
 * What it does, for a fixed duration:
 *   - logs in N student accounts concurrently (POST /auth/login),
 *   - each logged-in student loops placing orders (POST /orders),
 *   - one or more admins loop draining the board (GET /admin/orders, then
 *     PATCH /admin/orders/:id/status),
 * and reports latency percentiles, throughput, and an error breakdown per
 * endpoint at the end.
 *
 * WHY THIS IS A SCRIPT AND NOT A VITEST TEST
 * The vitest suite physically cannot be aimed at production: tests/setup/
 * databaseGuard.ts refuses any connection string naming the live host, and
 * tests/setup/marker.ts additionally requires a klh_test_guard.marker table
 * that only exists in a freshly-migrated, never-used database. That guard is
 * a feature and this script does not weaken it — it never opens a database
 * connection at all. It is a pure HTTP client, exactly like a browser, so the
 * only access it has to production is access production already grants to
 * anyone holding a valid login.
 *
 * WHAT IT COSTS WHEN POINTED AT PRODUCTION
 * Orders created here are REAL rows on the live kitchen board. Driving one to
 * DELIVERED performs a REAL, irreversible stockQty decrement, writes audit-log
 * rows, and sends REAL Telegram messages to any student who has linked their
 * account. Hence the defaults below: dry run available, an explicit typed
 * confirmation for any non-local target, and orders stopped at COOKED so no
 * stock is consumed unless --deliver is passed.
 *
 * Cleanup afterwards: `npx tsx scripts/cleanTestOrders.ts --apply`.
 *
 * USAGE
 *   # see the plan, send nothing
 *   npx tsx scripts/perf/prodLoadTest.ts --dry-run \
 *     --api https://api.example.workers.dev --users creds.json
 *
 *   # actually run it
 *   LOAD_TEST_CONFIRM="I understand this writes to https://api.example.workers.dev" \
 *   npx tsx scripts/perf/prodLoadTest.ts \
 *     --api https://api.example.workers.dev --users creds.json \
 *     --duration 120 --admin-creds admin.json
 *
 * CREDENTIALS FILE (--users), JSON:
 *   [{ "identifier": "2300031234", "password": "...", "school": "KLH" }, ...]
 * Nothing is hardcoded and no password is printed, logged, or included in any
 * output this script produces.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type School = "KLH" | "DRK";

type LoadCredential = {
  identifier: string;
  password: string;
  school?: School;
};

type LoginResult = {
  token: string;
  role: string;
  name: string;
  kitchen: string | null;
  id: string;
  mustChangePassword: boolean;
};

type MenuItemLite = {
  id: string;
  name: string;
  kitchen: string;
  isAvailable: boolean;
  stockQty: number;
};

/**
 * One recorded HTTP call. Kept flat and primitive so a 2-minute run's worth of
 * these stays cheap to hold in memory.
 */
type Sample = {
  op: string;
  ms: number;
  status: number;
  ok: boolean;
  /** Application error code (e.g. TOO_MANY_ORDERS), when the API supplied one. */
  code?: string;
};

type Config = {
  apiUrl: string;
  usersFile: string;
  adminFile: string | null;
  durationMs: number;
  targetUsers: number;
  adminIntervalMs: number;
  studentThinkMs: number;
  itemsPerOrder: number;
  qtyPerItem: number;
  deliver: boolean;
  dryRun: boolean;
  loginRampMs: number;
  itemAllowlist: string[] | null;
  maxOrdersPerUser: number;
  timeoutMs: number;
};

type Session = { token: string; userId: string; identifier: string; kitchen: string | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Config {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number, got "${raw}"`);
    return parsed;
  };

  const apiUrl = (get("--api") ?? process.env.LOAD_TEST_API_URL ?? "").replace(/\/+$/, "");
  if (!apiUrl) {
    throw new Error(
      "No API base URL. Pass --api https://host or set LOAD_TEST_API_URL.\n" +
        "This is the BACKEND origin (the Worker), not the frontend site."
    );
  }
  if (!/^https?:\/\//.test(apiUrl)) throw new Error(`--api must include a scheme, got "${apiUrl}"`);

  const usersFile = get("--users") ?? process.env.LOAD_TEST_USERS_FILE ?? "";
  if (!usersFile) {
    throw new Error("No credentials file. Pass --users path/to/creds.json or set LOAD_TEST_USERS_FILE.");
  }

  const allowlistRaw = get("--items");

  return {
    apiUrl,
    usersFile,
    adminFile: get("--admin-creds") ?? process.env.LOAD_TEST_ADMIN_FILE ?? null,
    durationMs: num("--duration", 120) * 1000,
    targetUsers: num("--concurrency", 100),
    adminIntervalMs: num("--admin-interval", 1000),
    studentThinkMs: num("--think", 12_000),
    itemsPerOrder: num("--items-per-order", 1),
    qtyPerItem: num("--qty", 1),
    deliver: has("--deliver"),
    dryRun: has("--dry-run"),
    loginRampMs: num("--login-ramp", 10) * 1000,
    itemAllowlist: allowlistRaw ? allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
    maxOrdersPerUser: num("--max-orders-per-user", 50),
    timeoutMs: num("--timeout", 30) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * A remote target must be named back to the script, in full, through an
 * environment variable. A typo'd host therefore cannot be loaded against, and
 * the confirmation cannot be satisfied by reflex-copying a single word.
 * Local targets skip this — nobody needs a ceremony to hammer their own laptop.
 */
function assertTargetConfirmed(cfg: Config): void {
  if (cfg.dryRun) return;
  if (LOCAL_HOST.test(cfg.apiUrl)) return;

  // Every login this script performs puts a real plaintext password in a
  // request body. Over http:// to a remote host that is a hundred passwords
  // read off the wire, so plaintext is allowed only for the local targets
  // already returned above.
  if (!/^https:\/\//i.test(cfg.apiUrl)) {
    throw new Error(
      `Refusing to send real credentials over plaintext HTTP to a non-local target: ${cfg.apiUrl}\n` +
        "Use https:// for any remote host."
    );
  }

  const expected = `I understand this writes to ${cfg.apiUrl}`;
  const supplied = process.env.LOAD_TEST_CONFIRM ?? "";
  if (supplied.trim() !== expected) {
    throw new Error(
      "Refusing to run against a non-local target without confirmation.\n\n" +
        `This creates REAL orders on ${cfg.apiUrl}` +
        (cfg.deliver ? " and REAL, irreversible stock decrements (--deliver is on)." : ".") +
        `\n\nTo proceed, set:\n\n  LOAD_TEST_CONFIRM="${expected}"\n\n` +
        "Or add --dry-run to see the plan without sending anything."
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class Recorder {
  readonly samples: Sample[] = [];
  add(sample: Sample): void {
    this.samples.push(sample);
  }
}

/**
 * A single timed request. Never throws for an HTTP or network error — a 429
 * under load is a result to be measured, not an exception that should unwind a
 * worker loop. Transport failures are recorded as status 0.
 */
async function timedRequest(
  rec: Recorder,
  op: string,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: any; code?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const ms = performance.now() - started;
    const code = body && typeof body === "object" ? (body.code ?? body.error?.code) : undefined;
    rec.add({ op, ms, status: res.status, ok: res.ok, code });
    return { ok: res.ok, status: res.status, body, code };
  } catch (err: any) {
    const ms = performance.now() - started;
    const code = err?.name === "AbortError" ? "TIMEOUT" : (err?.code ?? "NETWORK_ERROR");
    rec.add({ op, ms, status: 0, ok: false, code });
    return { ok: false, status: 0, body: null, code };
  } finally {
    clearTimeout(timer);
  }
}

const authHeaders = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function loadCredentials(file: string, label: string): Promise<LoadCredential[]> {
  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Cannot read ${label} file: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} file is not valid JSON: ${file}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} file must be a JSON array of {identifier, password, school}: ${file}`);
  }

  const creds = parsed.map((entry: any, i: number) => {
    if (!entry || typeof entry.identifier !== "string" || typeof entry.password !== "string") {
      throw new Error(`${label} entry ${i} must have string "identifier" and "password"`);
    }
    const school = entry.school ?? "KLH";
    if (school !== "KLH" && school !== "DRK") {
      throw new Error(`${label} entry ${i} has school "${school}"; must be "KLH" or "DRK"`);
    }
    return { identifier: entry.identifier, password: entry.password, school } as LoadCredential;
  });

  if (creds.length === 0) throw new Error(`${label} file contains no entries: ${file}`);
  return creds;
}

// ---------------------------------------------------------------------------
// Phase 1 — login
// ---------------------------------------------------------------------------

/**
 * Logs everyone in, spread across a ramp window.
 *
 * The ramp is not politeness — a simultaneous 100-way login burst is a
 * bcrypt-bound thundering herd that measures the login endpoint rather than
 * the ordering path this script exists to exercise. Spreading it produces a
 * realistic arrival pattern and leaves the steady state legible.
 */
async function loginAll(
  rec: Recorder,
  cfg: Config,
  creds: LoadCredential[]
): Promise<{ sessions: Session[]; failures: { identifier: string; status: number; code?: string }[] }> {
  const sessions: Session[] = [];
  const failures: { identifier: string; status: number; code?: string }[] = [];
  const gap = creds.length > 1 ? cfg.loginRampMs / creds.length : 0;

  await Promise.all(
    creds.map(async (cred, index) => {
      if (gap > 0) await sleep(index * gap);
      const res = await timedRequest(
        rec,
        "POST /auth/login",
        `${cfg.apiUrl}/auth/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: cred.identifier,
            password: cred.password,
            school: cred.school ?? "KLH",
          }),
        },
        cfg.timeoutMs
      );

      if (!res.ok) {
        failures.push({ identifier: cred.identifier, status: res.status, code: res.code });
        return;
      }
      const login = res.body as LoginResult;

      // A flagged account's token is refused by requireAuth() on every route
      // except the change-password endpoints, so it can log in but can never
      // order. Counting it as a live session would silently understate the
      // ordering failure rate for the whole run.
      if (login.mustChangePassword) {
        failures.push({ identifier: cred.identifier, status: res.status, code: "MUST_CHANGE_PASSWORD" });
        return;
      }
      sessions.push({
        token: login.token,
        userId: login.id,
        identifier: cred.identifier,
        kitchen: login.kitchen,
      });
    })
  );

  return { sessions, failures };
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Picks the items orders will be placed against.
 *
 * Deliberately conservative: only available items with real stock, and if
 * --items was supplied, only those. On a live system this is the difference
 * between a load test and an outage — without it, a 2-minute run can drain
 * every popular item on the board and leave real students unable to order.
 */
async function loadOrderableItems(rec: Recorder, cfg: Config, token: string): Promise<MenuItemLite[]> {
  const res = await timedRequest(
    rec,
    "GET /menu",
    `${cfg.apiUrl}/menu`,
    { headers: authHeaders(token) },
    cfg.timeoutMs
  );
  if (!res.ok) throw new Error(`Cannot load menu (HTTP ${res.status}${res.code ? ` ${res.code}` : ""})`);

  // GET /menu returns { categories: [ { ...category, items: [...] } ] } — see
  // getCategorizedMenu in services/menuService.ts. `kitchen` lives on the
  // CATEGORY, not on the item, and there is no back-reference from item to
  // category, so it has to be stamped on during the flatten or every item
  // reads as UNKNOWN.
  const body = res.body;
  const categories: any[] = Array.isArray(body?.categories) ? body.categories : [];
  const raw: any[] = categories.flatMap((category: any) =>
    Array.isArray(category?.items)
      ? category.items.map((item: any) => ({ ...item, kitchen: item.kitchen ?? category.kitchen }))
      : []
  );

  const items: MenuItemLite[] = raw
    .filter((i) => i && typeof i.id === "string")
    .map((i) => ({
      id: i.id,
      name: i.name ?? "(unnamed)",
      kitchen: i.kitchen ?? "UNKNOWN",
      isAvailable: i.isAvailable !== false,
      // For a non-admin caller this is ALREADY net of reservedQty (the
      // customer projection returns stockQty - reservedQty), so filtering on
      // > 0 below is filtering on genuinely sellable stock.
      stockQty: Number(i.stockQty ?? 0),
    }));

  const usable = items.filter(
    (i) =>
      i.isAvailable &&
      i.stockQty > 0 &&
      (!cfg.itemAllowlist || cfg.itemAllowlist.includes(i.id) || cfg.itemAllowlist.includes(i.name))
  );

  if (usable.length === 0) {
    throw new Error(
      cfg.itemAllowlist
        ? "No available, in-stock items matched --items. Check the ids/names."
        : "No available, in-stock menu items to order. Cannot run."
    );
  }
  return usable;
}

// ---------------------------------------------------------------------------
// Phase 2 — student order loop
// ---------------------------------------------------------------------------

/**
 * One student, ordering on a loop until the clock runs out.
 *
 * The think time is jittered per iteration, not fixed. A fixed sleep makes
 * every virtual user re-fire in lockstep for the whole run — a self-inflicted
 * synchronised spike that measures the harness rather than the server.
 */
async function studentLoop(
  rec: Recorder,
  cfg: Config,
  session: Session,
  items: MenuItemLite[],
  deadline: number,
  counters: { ordersPlaced: number; ordersRejected: number }
): Promise<string[]> {
  const created: string[] = [];
  let placed = 0;

  while (Date.now() < deadline && placed < cfg.maxOrdersPerUser) {
    const picked: MenuItemLite[] = [];
    for (let i = 0; i < cfg.itemsPerOrder; i++) {
      picked.push(items[Math.floor(Math.random() * items.length)]);
    }
    // Collapse duplicate picks — the API takes one line per menu item.
    const byId = new Map<string, number>();
    for (const item of picked) byId.set(item.id, (byId.get(item.id) ?? 0) + cfg.qtyPerItem);

    const res = await timedRequest(
      rec,
      "POST /orders",
      `${cfg.apiUrl}/orders`,
      {
        method: "POST",
        headers: authHeaders(session.token),
        body: JSON.stringify({
          items: [...byId.entries()].map(([menuItemId, qty]) => ({ menuItemId, qty })),
        }),
      },
      cfg.timeoutMs
    );

    if (res.ok) {
      placed++;
      counters.ordersPlaced++;
      // POST /orders returns an array — one order per kitchen the basket spans.
      const orders = Array.isArray(res.body) ? res.body : [res.body];
      for (const order of orders) if (order?.id) created.push(order.id);
    } else {
      counters.ordersRejected++;
    }

    // Jittered 0.5x-1.5x think time.
    const jitter = cfg.studentThinkMs * (0.5 + Math.random());
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(jitter, remaining));
  }

  return created;
}

// ---------------------------------------------------------------------------
// Phase 3 — admin accept loop
// ---------------------------------------------------------------------------

/**
 * One admin working the board on a loop: read the active list, then advance
 * each order one step.
 *
 * The board's flow is PENDING -> COOKED -> DELIVERED (PREPARING is retired as
 * an inbound transition; see NEXT_STATUS in orderService.ts). Advancing is
 * therefore always "COOKED for a PENDING/PREPARING order, DELIVERED for a
 * COOKED one" — sending anything else earns a 409 INVALID_TRANSITION and would
 * pollute the error breakdown with the harness's own bug.
 *
 * DELIVERED is skipped unless --deliver, because that is the transition that
 * spends real stock.
 */
async function adminLoop(
  rec: Recorder,
  cfg: Config,
  session: Session,
  deadline: number,
  counters: { accepted: number; delivered: number; acceptFailed: number },
  /**
   * Ids some admin worker has already taken responsibility for this tick.
   *
   * Every admin polls the same board and gets the same rows, so without this
   * two workers both see one PENDING order and both PATCH it to COOKED. The
   * server is correct either way — updateOrderStatus takes a row lock and the
   * loser gets 409 INVALID_TRANSITION — but those 409s are the harness racing
   * itself, and they would land in the error report as if the API had failed.
   * All admin loops share one event loop, so a plain Set is sufficient
   * coordination.
   */
  claimed: Set<string>
): Promise<void> {
  while (Date.now() < deadline) {
    const list = await timedRequest(
      rec,
      "GET /admin/orders",
      `${cfg.apiUrl}/admin/orders?limit=50`,
      { headers: authHeaders(session.token) },
      cfg.timeoutMs
    );

    if (list.ok) {
      const orders: any[] = Array.isArray(list.body) ? list.body : (list.body?.data ?? []);
      for (const order of orders) {
        if (Date.now() >= deadline) break;
        if (!order?.id) continue;

        const next =
          order.status === "PENDING" || order.status === "PREPARING"
            ? "COOKED"
            : order.status === "COOKED"
              ? "DELIVERED"
              : null;
        if (!next) continue;
        if (next === "DELIVERED" && !cfg.deliver) continue;
        // Another admin worker already owns this one.
        if (claimed.has(order.id)) continue;
        claimed.add(order.id);

        const patch = await timedRequest(
          rec,
          "PATCH /admin/orders/:id/status",
          `${cfg.apiUrl}/admin/orders/${order.id}/status`,
          { method: "PATCH", headers: authHeaders(session.token), body: JSON.stringify({ status: next }) },
          cfg.timeoutMs
        );

        if (patch.ok) {
          if (next === "DELIVERED") counters.delivered++;
          else counters.accepted++;
          // A COOKED order still has a DELIVERED step left in it, so release
          // the claim; the next poll re-picks it up (or skips it when
          // --deliver is off).
          if (next !== "DELIVERED") claimed.delete(order.id);
        } else {
          counters.acceptFailed++;
          // Failed, so nobody owns it — let another worker try next tick.
          claimed.delete(order.id);
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(cfg.adminIntervalMs, remaining));
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function report(rec: Recorder, cfg: Config, elapsedMs: number): void {
  const byOp = new Map<string, Sample[]>();
  for (const sample of rec.samples) {
    const bucket = byOp.get(sample.op);
    if (bucket) bucket.push(sample);
    else byOp.set(sample.op, [sample]);
  }

  console.log("\n" + "=".repeat(80));
  console.log(`RESULTS  target=${cfg.apiUrl}  duration=${(elapsedMs / 1000).toFixed(1)}s`);
  console.log("=".repeat(80));
  console.log(
    [
      "operation".padEnd(30),
      "n".padStart(6),
      "ok".padStart(6),
      "p50".padStart(8),
      "p95".padStart(8),
      "p99".padStart(8),
      "max".padStart(8),
      "rps".padStart(7),
    ].join(" ")
  );
  console.log("-".repeat(80));

  for (const [op, samples] of [...byOp.entries()].sort()) {
    const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
    const ok = samples.filter((s) => s.ok).length;
    const rps = samples.length / (elapsedMs / 1000);
    console.log(
      [
        op.padEnd(30),
        String(samples.length).padStart(6),
        `${Math.round((ok / samples.length) * 100)}%`.padStart(6),
        `${percentile(latencies, 50).toFixed(0)}ms`.padStart(8),
        `${percentile(latencies, 95).toFixed(0)}ms`.padStart(8),
        `${percentile(latencies, 99).toFixed(0)}ms`.padStart(8),
        `${latencies[latencies.length - 1].toFixed(0)}ms`.padStart(8),
        rps.toFixed(1).padStart(7),
      ].join(" ")
    );
  }

  const failed = rec.samples.filter((s) => !s.ok);
  if (failed.length > 0) {
    console.log("\nFailures by operation / status / code:");
    const tally = new Map<string, number>();
    for (const sample of failed) {
      const key = `${sample.op}  ${sample.status || "network"}  ${sample.code ?? "-"}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)}  ${key}`);
    }
    // 429s are the expected shape of this test against default limits, not a
    // defect — the app rate-limits orders to 5/min per identity and all
    // traffic to 100/min. Say so, so nobody reads a working limiter as a bug.
    const throttled = failed.filter((s) => s.status === 429).length;
    if (throttled > 0) {
      console.log(
        `\n  ${throttled} request(s) were rate-limited (429). That is the limiter working:\n` +
          "  POST /orders allows 5/min per identity and the global limit is 100/min.\n" +
          "  Raise those limits deliberately if you want to measure past them."
      );
    }
  } else {
    console.log("\nNo failures.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  assertTargetConfirmed(cfg);

  const studentCreds = await loadCredentials(cfg.usersFile, "students");
  const adminCreds = cfg.adminFile ? await loadCredentials(cfg.adminFile, "admins") : [];
  const selected = studentCreds.slice(0, cfg.targetUsers);

  console.log("PLAN");
  console.log(`  target            ${cfg.apiUrl}`);
  console.log(`  students          ${selected.length} (of ${studentCreds.length} in file)`);
  console.log(`  admins            ${adminCreds.length}`);
  console.log(`  duration          ${cfg.durationMs / 1000}s`);
  console.log(`  login ramp        ${cfg.loginRampMs / 1000}s`);
  console.log(`  think time        ~${cfg.studentThinkMs / 1000}s (jittered 0.5x-1.5x)`);
  console.log(`  order shape       ${cfg.itemsPerOrder} item(s) x qty ${cfg.qtyPerItem}`);
  console.log(
    `  admin advances to ${cfg.deliver ? "DELIVERED (SPENDS REAL STOCK)" : "COOKED only (no stock spent)"}`
  );
  console.log(`  item allowlist    ${cfg.itemAllowlist ? cfg.itemAllowlist.join(", ") : "(none — any available item)"}`);

  if (cfg.dryRun) {
    console.log("\n--dry-run: nothing sent. Remove --dry-run to execute.");
    return;
  }

  // The credentials file holds plaintext passwords for real, working accounts.
  // backend/.gitignore covers the generated names, but the --users flag takes
  // any path, so say this out loud rather than relying on the ignore rules.
  console.log("\nReminder: the credentials file holds plaintext passwords. Keep it out of the");
  console.log("repo and restrict its permissions; delete it when the run is finished.");
  if (adminCreds.length === 0) {
    console.log("\nNote: no --admin-creds given, so orders will be created but never accepted.");
  }

  const rec = new Recorder();
  const runStarted = performance.now();

  console.log("\nLogging in...");
  const [students, admins] = await Promise.all([
    loginAll(rec, cfg, selected),
    adminCreds.length > 0
      ? loginAll(rec, cfg, adminCreds)
      : Promise.resolve({ sessions: [] as Session[], failures: [] as { identifier: string; status: number; code?: string }[] }),
  ]);

  console.log(`  students: ${students.sessions.length} in, ${students.failures.length} failed`);
  if (students.failures.length > 0) {
    const tally = new Map<string, number>();
    for (const f of students.failures) {
      const key = f.code ?? String(f.status);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    for (const [code, count] of tally) console.log(`    ${count} x ${code}`);
  }
  console.log(`  admins:   ${admins.sessions.length} in, ${admins.failures.length} failed`);

  if (students.sessions.length === 0) throw new Error("No student sessions established; nothing to load with.");

  const items = await loadOrderableItems(rec, cfg, students.sessions[0].token);
  console.log(`\nOrderable items: ${items.length}`);
  for (const item of items.slice(0, 10)) console.log(`  ${item.name} (${item.kitchen}, stock ${item.stockQty})`);
  if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);

  const deadline = Date.now() + cfg.durationMs;
  const studentCounters = { ordersPlaced: 0, ordersRejected: 0 };
  const adminCounters = { accepted: 0, delivered: 0, acceptFailed: 0 };

  console.log(`\nRunning for ${cfg.durationMs / 1000}s...`);
  const ticker = setInterval(() => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    process.stdout.write(
      `\r  ${left}s left | placed ${studentCounters.ordersPlaced} rejected ${studentCounters.ordersRejected}` +
        ` | accepted ${adminCounters.accepted} delivered ${adminCounters.delivered}   `
    );
  }, 1000);

  try {
    // Students and admins run concurrently for the whole window — that overlap
    // is the point, since it is what puts ordering writes and the board's
    // status writes on the same rows at the same time.
    const claimed = new Set<string>();
    await Promise.all([
      ...students.sessions.map((s) => studentLoop(rec, cfg, s, items, deadline, studentCounters)),
      ...admins.sessions.map((s) => adminLoop(rec, cfg, s, deadline, adminCounters, claimed)),
    ]);
  } finally {
    clearInterval(ticker);
    process.stdout.write("\n");
  }

  const elapsed = performance.now() - runStarted;
  report(rec, cfg, elapsed);

  console.log("\nTOTALS");
  console.log(`  orders placed      ${studentCounters.ordersPlaced}`);
  console.log(`  orders rejected    ${studentCounters.ordersRejected}`);
  console.log(`  advanced to COOKED ${adminCounters.accepted}`);
  console.log(`  delivered          ${adminCounters.delivered}`);
  console.log(`  admin failures     ${adminCounters.acceptFailed}`);
  console.log("\nCleanup: npx tsx scripts/cleanTestOrders.ts --apply");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
