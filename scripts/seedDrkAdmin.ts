/**
 * Creates (or updates) a single DRK admin account.
 *
 * Separate from seedAdmin.ts on purpose: that script owns the canonical
 * bootstrap accounts and rewrites several rows every run. This one touches
 * exactly one row, so it can be handed to an operator who needs to restore
 * DRK admin access without re-seeding anything else.
 *
 * Two things this account MUST carry, both of which are silent-failure traps:
 *
 *   school='DRK'  — login() rejects a correct password presented against the
 *                   wrong school (authService.ts), and the column defaults to
 *                   'KLH'. A DRK admin seeded without it can never sign in
 *                   from the DRK side of the login picker.
 *   kitchen=NULL  — every kitchen check reads `user.kitchen || undefined` and
 *                   treats NULL as unrestricted, so this one account manages
 *                   both SNACKS and MEALS.
 *
 * mustChangePassword defaults to FALSE, matching the accounts on
 * seedAdmin.ts's exempt list: this is the way back INTO the admin UI, and
 * flagging it means the operator's first login lands on a password-change
 * screen instead of the board they were trying to reach. The supplied
 * password is therefore permanent until someone changes it deliberately.
 *
 * Set SEED_DRK_FORCE_CHANGE=true to flag the account instead, which is the
 * right call when the password was transmitted somewhere it shouldn't have
 * been and is meant to be a one-time credential.
 *
 * Usage:
 *   SEED_DRK_EMAIL=admin@drk SEED_DRK_PASSWORD=... npx tsx scripts/seedDrkAdmin.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getPool } from "../src/lib/db.js";
import { sql, query } from "../src/db/sql.js";
import type { User } from "../src/db/schema.js";

const email = process.env.SEED_DRK_EMAIL;
const password = process.env.SEED_DRK_PASSWORD;
const name = process.env.SEED_DRK_NAME ?? "DRK Admin";
const forceChange = process.env.SEED_DRK_FORCE_CHANGE === "true";

if (!email || !password) {
  console.error("SEED_DRK_EMAIL and SEED_DRK_PASSWORD are both required.");
  process.exit(1);
}

const pool = getPool(process.env.DATABASE_URL!);

async function main() {
  // Cost 10 matches the admin accounts in seedAdmin.ts. (Students use 12 —
  // they log in far less often, so the extra work is affordable there.)
  const passwordHash = await bcrypt.hash(password!, 10);

  const existing = await query<User>(
    pool,
    sql`SELECT "id", "email", "role", "school", "isActive" FROM "User" WHERE "email" = ${email}`
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    // Reset in place rather than insert — email is unique, and an operator
    // running this against an existing account almost certainly means "I
    // cannot get in", not "make me a second one".
    await query(
      pool,
      sql`UPDATE "User"
             SET "passwordHash" = ${passwordHash},
                 "role" = 'ADMIN',
                 "school" = 'DRK',
                 "kitchen" = NULL,
                 "isActive" = true,
                 "mustChangePassword" = ${forceChange},
                 "tokensValidFrom" = now()
           WHERE "id" = ${row.id}`
    );
    // tokensValidFrom is bumped so any session already holding a token for
    // this account is invalidated — a password reset that leaves old sessions
    // alive is not a reset.
    console.log(`UPDATED existing account ${email} (id ${row.id}) — password reset, sessions revoked.`);
    return;
  }

  const id = crypto.randomUUID();
  await query(
    pool,
    sql`INSERT INTO "User" ("id", "role", "email", "passwordHash", "name", "kitchen", "school", "mustChangePassword", "isActive")
        VALUES (${id}, 'ADMIN', ${email}, ${passwordHash}, ${name}, NULL, 'DRK', ${forceChange}, true)`
  );
  console.log(`CREATED ${email} (id ${id}) — role ADMIN, school DRK, kitchen unrestricted.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
