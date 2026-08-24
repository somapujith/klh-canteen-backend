/**
 * CLI for the student-username backfill.
 *
 *   Preview (writes NOTHING — this is the default):
 *     npx tsx scripts/backfillStudentUsernames.ts
 *
 *   Apply:
 *     npx tsx scripts/backfillStudentUsernames.ts --apply
 *
 * Runs against whatever DATABASE_URL resolves to — `.env` unless one is set on
 * the command line. All of the behaviour, the safety argument and the rollback
 * statement live in src/services/studentUsernameBackfill.ts; this file is only
 * the wiring and the printing.
 */
import "dotenv/config";
import { getPrisma } from "../src/lib/prisma.js";
import {
  previewStudentUsernameBackfill,
  applyStudentUsernameBackfill,
} from "../src/services/studentUsernameBackfill.js";

const apply = process.argv.includes("--apply");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const prisma = getPrisma(databaseUrl);

async function main() {
  const preview = await previewStudentUsernameBackfill(prisma);

  console.log("");
  console.log(`STUDENT accounts total ............ ${preview.totalStudents}`);
  console.log(`already a bare username .......... ${preview.alreadyBare}`);
  console.log(`to convert ....................... ${preview.convertible.length}`);
  console.log(`blocked by a username collision .. ${preview.blocked.length}`);
  console.log("");

  for (const r of preview.convertible.slice(0, 10)) {
    console.log(`  ${r.email}  ->  ${r.target}   (${r.name})`);
  }
  if (preview.convertible.length > 10) {
    console.log(`  ... and ${preview.convertible.length - 10} more`);
  }
  for (const r of preview.blocked) {
    console.log(`  BLOCKED  ${r.email}  ->  ${r.target}  — that username is already taken`);
  }

  if (!apply) {
    console.log("");
    console.log("Dry run — nothing was written.");
    console.log("Re-run with --apply to perform the update.");
    return;
  }
  if (preview.convertible.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const changed = await applyStudentUsernameBackfill(prisma);
  console.log("");
  console.log(`Updated ${changed} student username(s).`);
  console.log("Old and new forms both still log in — see login() in src/services/authService.ts.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
