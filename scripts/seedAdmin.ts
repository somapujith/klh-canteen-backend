import "dotenv/config";
import bcrypt from "bcryptjs";
import { getPrisma } from "../src/lib/prisma.js";

const prisma = getPrisma(process.env.DATABASE_URL!);

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
  await prisma.user.upsert({
    where: { email: "snacks_admin@klh.edu.in" },
    update: { passwordHash, name: "Snacks Admin", kitchen: "SNACKS", mustChangePassword: false, isActive: true },
    create: {
      email: "snacks_admin@klh.edu.in",
      passwordHash,
      name: "Snacks Admin",
      role: "ADMIN",
      kitchen: "SNACKS",
      mustChangePassword: false,
    },
  });

  // Meals Admin
  await prisma.user.upsert({
    where: { email: "meals_admin@klh.edu.in" },
    update: { passwordHash, name: "Meals Admin", kitchen: "MEALS", mustChangePassword: false, isActive: true },
    create: {
      email: "meals_admin@klh.edu.in",
      passwordHash,
      name: "Meals Admin",
      role: "ADMIN",
      kitchen: "MEALS",
      mustChangePassword: false,
    },
  });

  // Super Admin
  await prisma.user.upsert({
    where: { email: "superadmin@klh.edu.in" },
    update: { passwordHash, name: "Super Admin", mustChangePassword: false, isActive: true },
    create: {
      email: "superadmin@klh.edu.in",
      passwordHash,
      name: "Super Admin",
      role: "SUPERADMIN",
      mustChangePassword: false,
    },
  });

  // Demo Student (matches the "Student Account" quick-fill on the login page)
  await prisma.user.upsert({
    where: { email: studentEmail },
    // The demo student is exempt too: a live demo is being recorded against
    // this login and must not hit a change-password wall mid-take.
    update: {
      passwordHash: studentPasswordHash,
      name: "Demo Student",
      rollNumber: studentRollNumber,
      mustChangePassword: false,
      isActive: true,
    },
    create: {
      email: studentEmail,
      passwordHash: studentPasswordHash,
      name: "Demo Student",
      role: "STUDENT",
      rollNumber: studentRollNumber,
      mustChangePassword: false,
    },
  });

  console.log(`Student seeded: ${studentEmail} (roll ${studentRollNumber})`);
  console.log("Admins seeded: snacks_admin@klh.edu.in & meals_admin@klh.edu.in & superadmin@klh.edu.in");
  console.log("Seeded accounts are exempt from the forced password change (mustChangePassword=false).");

  await flagExistingStudentsIfRequested(studentEmail);

  await prisma.$disconnect();
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
  const { count } = await prisma.user.updateMany({
    where: { role: "STUDENT", mustChangePassword: false, email: { notIn: exempt } },
    data: {
      mustChangePassword: true,
      // Their current sessions were opened on the shared password, so they go
      // too — otherwise a live token keeps ordering right past the new flag.
      tokensValidFrom: new Date(Math.floor(Date.now() / 1000) * 1000 + 1000),
    },
  });
  console.log(`Flagged ${count} existing student account(s) for a forced password change.`);
}

main();
