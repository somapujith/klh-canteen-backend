import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getPool } from "../src/lib/db.js";
import { sql, query } from "../src/db/sql.js";
import type { User } from "../src/db/schema.js";

const pool = getPool(process.env.DATABASE_URL!);

/**
 * FORCED PASSWORD CHANGE AND THE ACCOUNTS THAT ARE EXEMPT FROM IT
 * ---------------------------------------------------------------
 * Bulk-created students land with mustChangePassword=true (see
 * services/studentRosterService.ts) because they all share `klh@123` and their
 * roll numbers are public. The accounts seeded HERE are explicitly the other
 * case, and every one of them is written with mustChangePassword: false rather
 * than left to the column default — an exemption that depends on a default is
 * an exemption that silently disappears the day the default changes:
 *
 *   superadmin@klh.edu.in / snacks_admin@klh.edu.in / meals_admin@klh.edu.in
 *     The only way back into the admin UI. Flagging them means nobody can
 *     reach the screen that un-flags anybody.
 *   student@klh.edu.in
 *     The demo student a live recording is being made against. It must keep
 *     behaving exactly as it does today.
 *
 * THE 150 REAL STUDENTS (2420090001-2420090154) ARE ALSO NOT FLAGGED.
 * They already exist, and a load-testing harness mints tokens for them offline
 * and places orders. Flagging them would make requireAuth() reject those orders
 * with PASSWORD_CHANGE_REQUIRED and break the harness. The choice made here is
 * therefore: FLAG ONLY NEWLY IMPORTED STUDENTS, BACKFILL NOTHING. This script
 * never writes mustChangePassword to a row it did not create.
 *
 * When the load test is retired and the real cohort should be forced onto their
 * own passwords, run this script once with:
 *
 *   FLAG_EXISTING_STUDENTS=true npm run seed:admin
 *
 * which flags every STUDENT except the exempt list above. It is opt-in, and off
 * by default, so an ordinary re-seed can never break the harness or the demo.
 * The second escape hatch is the ENFORCE_PASSWORD_CHANGE=false binding, which
 * disarms the gate app-wide without touching a single row.
 */

/** Accounts that must keep working without a forced password change. */
const EXEMPT_EMAILS = [
  "superadmin@klh.edu.in",
  "snacks_admin@klh.edu.in",
  "meals_admin@klh.edu.in",
];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@klh.edu.in";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";
  const passwordHash = await bcrypt.hash(password, 10);

  const studentEmail = process.env.SEED_STUDENT_EMAIL ?? "student@klh.edu.in";
  const studentPassword = process.env.SEED_STUDENT_PASSWORD ?? "student123";
  const studentRollNumber = process.env.SEED_STUDENT_ROLL ?? "2400000001";
  const studentPasswordHash = await bcrypt.hash(studentPassword, 12);

  // Snacks Admin
  await query<User>(
    pool,
    sql`
      INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "kitchen", "mustChangePassword")
      VALUES (${crypto.randomUUID()}, 'snacks_admin@klh.edu.in', ${passwordHash}, 'Snacks Admin', 'ADMIN'::"Role", 'SNACKS'::"Kitchen", false)
      ON CONFLICT ("email") DO UPDATE SET
        "passwordHash" = EXCLUDED."passwordHash",
        "name" = EXCLUDED."name",
        "kitchen" = EXCLUDED."kitchen",
        "mustChangePassword" = EXCLUDED."mustChangePassword",
        "isActive" = true
      RETURNING *
    `,
  );

  // Meals Admin
  await query<User>(
    pool,
    sql`
      INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "kitchen", "mustChangePassword")
      VALUES (${crypto.randomUUID()}, 'meals_admin@klh.edu.in', ${passwordHash}, 'Meals Admin', 'ADMIN'::"Role", 'MEALS'::"Kitchen", false)
      ON CONFLICT ("email") DO UPDATE SET
        "passwordHash" = EXCLUDED."passwordHash",
        "name" = EXCLUDED."name",
        "kitchen" = EXCLUDED."kitchen",
        "mustChangePassword" = EXCLUDED."mustChangePassword",
        "isActive" = true
      RETURNING *
    `,
  );

  // Super Admin
  await query<User>(
    pool,
    sql`
      INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "mustChangePassword")
      VALUES (${crypto.randomUUID()}, 'superadmin@klh.edu.in', ${passwordHash}, 'Super Admin', 'SUPERADMIN'::"Role", false)
      ON CONFLICT ("email") DO UPDATE SET
        "passwordHash" = EXCLUDED."passwordHash",
        "name" = EXCLUDED."name",
        "mustChangePassword" = EXCLUDED."mustChangePassword",
        "isActive" = true
      RETURNING *
    `,
  );

  // Demo Student (matches the "Student Account" quick-fill on the login page)
  await query<User>(
    pool,
    sql`
      INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "rollNumber", "mustChangePassword")
      VALUES (${crypto.randomUUID()}, ${studentEmail}, ${studentPasswordHash}, 'Demo Student', 'STUDENT'::"Role", ${studentRollNumber}, false)
      ON CONFLICT ("email") DO UPDATE SET
        "passwordHash" = EXCLUDED."passwordHash",
        "name" = EXCLUDED."name",
        "rollNumber" = EXCLUDED."rollNumber",
        "mustChangePassword" = EXCLUDED."mustChangePassword",
        "isActive" = true
      RETURNING *
    `,
  );

  console.log(`Student seeded: ${studentEmail} (roll ${studentRollNumber})`);
  console.log("Admins seeded: snacks_admin@klh.edu.in & meals_admin@klh.edu.in & superadmin@klh.edu.in");
  console.log("Seeded accounts are exempt from the forced password change (mustChangePassword=false).");

  await flagExistingStudentsIfRequested(studentEmail);

  await pool.end();
}

/**
 * OPT-IN backfill. Off unless FLAG_EXISTING_STUDENTS=true.
 *
 * Forces every pre-existing STUDENT onto their own password. This is the switch
 * to throw once the load-testing harness is retired — until then it stays off,
 * because flagging that cohort is exactly what would break it.
 */
async function flagExistingStudentsIfRequested(demoStudentEmail: string) {
  if (process.env.FLAG_EXISTING_STUDENTS !== "true") {
    console.log(
      "Existing students left unflagged (set FLAG_EXISTING_STUDENTS=true to force them onto their own passwords)."
    );
    return;
  }

  const exempt = [...EXEMPT_EMAILS, demoStudentEmail];
  const tokensValidFrom = new Date(Math.floor(Date.now() / 1000) * 1000 + 1000);
  const { rowCount } = await query(
    pool,
    sql`
      UPDATE "User"
      SET "mustChangePassword" = true, "tokensValidFrom" = ${tokensValidFrom}
      WHERE "role" = 'STUDENT'::"Role" AND "mustChangePassword" = false AND "email" <> ALL(${exempt}::text[])
    `,
  );
  console.log(`Flagged ${rowCount} existing student account(s) for a forced password change.`);
}

main();
