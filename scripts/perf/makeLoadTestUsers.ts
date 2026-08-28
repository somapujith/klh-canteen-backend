/**
 * Provisions dedicated load-test accounts and writes the credentials file that
 * scripts/perf/prodLoadTest.ts consumes.
 *
 * WHY DEDICATED ACCOUNTS INSTEAD OF REAL STUDENTS
 * The load test needs a password it can actually send. There are only two ways
 * to get one for an existing student: read it (impossible — bcrypt) or reset it
 * (which locks a real student out of their own account mid-term, and with
 * mustChangePassword set they could not order anyway). So this creates separate
 * accounts instead. Real rosters are never touched, and the accounts are
 * removable in one call afterwards.
 *
 * These accounts are REAL rows with REAL working logins on whatever database
 * DATABASE_URL names. Treat the file it writes as a secret — backend/.gitignore
 * already excludes `loadtest-*.json`.
 *
 * USAGE
 *   # create 100 accounts and write loadtest-users.json
 *   npx tsx scripts/perf/makeLoadTestUsers.ts --count 100 --out loadtest-users.json
 *
 *   # remove every account this script created
 *   npx tsx scripts/perf/makeLoadTestUsers.ts --cleanup
 *
 * The accounts are identifiable by a fixed roll-number prefix (LOADTEST-), so
 * --cleanup can never touch anything it did not create.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { getPool } from "../../src/lib/db.js";
import { sql, query } from "../../src/db/sql.js";

/**
 * The marker that makes cleanup safe. Every account created here carries it in
 * both rollNumber and email, and cleanup deletes strictly by this prefix — so a
 * mistyped flag cannot reach a real student row.
 */
const PREFIX = "LOADTEST-";
const EMAIL_DOMAIN = "loadtest.invalid";

/** Cost 10 matches authService.BCRYPT_COST, so these logins cost the server
 *  exactly what a real student's login costs. A cheaper hash here would make
 *  the login phase look faster than production actually is. */
const BCRYPT_COST = 10;

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const count = Number(get("--count") ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("--count must be an integer between 1 and 1000");
  }
  return {
    count,
    out: get("--out") ?? "loadtest-users.json",
    school: (get("--school") ?? "KLH") as "KLH" | "DRK",
    cleanup: argv.includes("--cleanup"),
  };
}

const cfg = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (expected in backend/.env).");
const pool = getPool(databaseUrl);

async function cleanup(): Promise<void> {
  // Orders first: Order.studentId references User, so the rows have to go in
  // dependency order or the delete is refused.
  const { rows: doomed } = await query<{ id: string; rollNumber: string }>(
    pool,
    sql`SELECT "id", "rollNumber" FROM "User" WHERE "rollNumber" LIKE ${PREFIX + "%"}`
  );
  if (doomed.length === 0) {
    console.log("No load-test accounts found. Nothing to do.");
    return;
  }
  const ids = doomed.map((u) => u.id);

  const { rows: orders } = await query<{ id: string }>(
    pool,
    sql`SELECT "id" FROM "Order" WHERE "studentId" = ANY(${ids}::text[])`
  );
  const orderIds = orders.map((o) => o.id);

  if (orderIds.length > 0) {
    await query(pool, sql`DELETE FROM "OrderItem" WHERE "orderId" = ANY(${orderIds}::text[])`);
    await query(pool, sql`DELETE FROM "Order" WHERE "id" = ANY(${orderIds}::text[])`);
  }
  await query(pool, sql`DELETE FROM "User" WHERE "id" = ANY(${ids}::text[])`);

  console.log(`Deleted ${doomed.length} load-test account(s) and ${orderIds.length} of their order(s).`);
}

async function provision(): Promise<void> {
  // One password for the whole cohort. These accounts exist only to generate
  // load and hold nothing worth protecting; a per-account password would make
  // the credentials file no less sensitive while making it harder to revoke.
  // 24 bytes of CSPRNG output, plus a letter and a digit so it clears
  // passwordPolicy's complexity rules.
  const password = `Lt${crypto.randomBytes(18).toString("base64url")}9`;
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const creds: { identifier: string; password: string; school: "KLH" | "DRK" }[] = [];

  for (let i = 0; i < cfg.count; i++) {
    const serial = String(i + 1).padStart(4, "0");
    const rollNumber = `${PREFIX}${serial}`;
    const email = `${rollNumber.toLowerCase()}@${EMAIL_DOMAIN}`;

    // mustChangePassword false is essential: requireAuth() refuses a flagged
    // account on every route except the change-password endpoints, so a
    // flagged load-test account could log in and then order nothing.
    await query(
      pool,
      sql`
        INSERT INTO "User" ("id", "role", "email", "rollNumber", "passwordHash", "name",
                            "school", "isActive", "mustChangePassword")
        VALUES (${crypto.randomUUID()}, 'STUDENT'::"Role", ${email}, ${rollNumber},
                ${passwordHash}, ${`Load Test ${serial}`}, ${cfg.school}::"School", true, false)
        ON CONFLICT ("email") DO UPDATE SET
          "passwordHash" = EXCLUDED."passwordHash",
          "isActive" = true,
          "mustChangePassword" = false
      `
    );
    creds.push({ identifier: rollNumber, password, school: cfg.school });
  }

  await writeFile(cfg.out, JSON.stringify(creds, null, 2), "utf8");

  console.log(`Provisioned ${cfg.count} load-test student account(s).`);
  console.log(`Credentials written to ${cfg.out} — treat as a secret; it is gitignored.`);
  console.log("\nAdmin accounts are NOT created here. Put an existing admin login in its own");
  console.log("file to pass as --admin-creds, e.g.:");
  console.log('  [{ "identifier": "admin@klh.edu.in", "password": "...", "school": "KLH" }]');
  console.log(`\nWhen finished:  npx tsx scripts/perf/makeLoadTestUsers.ts --cleanup`);
}

try {
  if (cfg.cleanup) await cleanup();
  else await provision();
} finally {
  await pool.end();
}
process.exit(0);
