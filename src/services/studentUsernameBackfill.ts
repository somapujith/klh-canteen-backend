/**
 * ONE-OFF BACKFILL — strips the synthetic `@klh.edu.in` suffix from student
 * usernames so `User.email` holds the bare roll number.
 *
 * The CLI that drives it is scripts/backfillStudentUsernames.ts. The logic
 * lives here, taking an injected PrismaClient, so the suite can run it against
 * the disposable test database instead of it only ever being exercised for the
 * first time against the live one.
 *
 * WHAT IT TOUCHES, AND WHAT IT REFUSES TO
 * ---------------------------------------
 * Exactly one shape of row: role = STUDENT, `rollNumber` set, and `email`
 * equal to `lower(rollNumber) || '@klh.edu.in'` — i.e. a username that
 * studentRosterService synthesised, which carries no information the
 * `rollNumber` column does not already hold.
 *
 * Everything else is invisible to it:
 *   - ADMIN / SUPERADMIN rows. Their addresses are real and deliverable and
 *     are the only way back into the admin UI. The role filter is the first
 *     predicate for exactly that reason.
 *   - `student@klh.edu.in`, the demo/load-test account. Its roll number is
 *     2400000001, so its email is not `<roll>@klh.edu.in` and the equality
 *     never holds. It also sits in PROTECTED_ACCOUNT_EMAILS, which is matched
 *     by email — leaving it alone keeps that guard working.
 *   - Any student whose email was typed by a human rather than synthesised
 *     (`asha@klh.edu.in` against roll 23BCE001). Same equality, same miss.
 *
 * IDEMPOTENT. After a successful run the predicate is false for every row it
 * changed (`email` now equals `lower(rollNumber)`, not the suffixed form), so
 * a second run reports 0 and writes nothing. Safe to re-run, and safe to run
 * while the app is serving traffic: login() accepts both forms.
 *
 * COLLISION-SAFE. `User.email` is UNIQUE. If some other row already occupies
 * the bare roll number, that student is skipped and reported rather than
 * taking the whole statement down with a constraint violation. Nothing is
 * lost — a skipped student keeps their old username and can still log in
 * either way. Investigate the duplicate, then re-run.
 *
 * ROLLBACK. The inverse is the same statement with the two sides swapped, and
 * is equally idempotent:
 *
 *   UPDATE "User"
 *      SET "email" = lower("rollNumber") || '@klh.edu.in'
 *    WHERE "role" = 'STUDENT'
 *      AND "rollNumber" IS NOT NULL
 *      AND "email" = lower("rollNumber");
 *
 * It is not exposed as a flag on purpose: reverting is a decision, not a
 * keystroke. Note that reverting the DATA is optional anyway — old and new
 * usernames both authenticate, so rolling the CODE back is sufficient to undo
 * a bad deploy.
 */
import type { PrismaClient } from "@prisma/client";

export const LEGACY_DOMAIN = "klh.edu.in";

/**
 * The rows this backfill converts, as a SQL predicate.
 *
 * Shared by the preview and the update so the two cannot drift apart and
 * report a count the write does not honour.
 */
const CONVERTIBLE = `
  "role" = 'STUDENT'
  AND "rollNumber" IS NOT NULL
  AND "email" = lower("rollNumber") || '@${LEGACY_DOMAIN}'
`;

/** Guards the UNIQUE index on User.email. Re-evaluated at write time. */
const NO_COLLISION = `
  NOT EXISTS (
    SELECT 1 FROM "User" o
    WHERE o."email" = lower("User"."rollNumber") AND o."id" <> "User"."id"
  )
`;

export interface BackfillRow {
  id: string;
  name: string;
  rollNumber: string;
  /** Current (suffixed) username. */
  email: string;
  /** What it would become. */
  target: string;
  /** True when `target` is already taken by another account. */
  collides: boolean;
}

export interface BackfillPreview {
  totalStudents: number;
  /** Students whose username already has no `@` in it — nothing left to do. */
  alreadyBare: number;
  convertible: BackfillRow[];
  blocked: BackfillRow[];
}

/** Read-only. Reports exactly what applyStudentUsernameBackfill() would change. */
export async function previewStudentUsernameBackfill(
  prisma: PrismaClient,
): Promise<BackfillPreview> {
  const rows = await prisma.$queryRawUnsafe<BackfillRow[]>(`
    SELECT "User"."id",
           "User"."name",
           "User"."rollNumber",
           "User"."email",
           lower("User"."rollNumber") AS "target",
           NOT (${NO_COLLISION})     AS "collides"
    FROM "User"
    WHERE ${CONVERTIBLE}
    ORDER BY "User"."rollNumber" ASC
  `);

  const [totalStudents, alreadyBare] = await Promise.all([
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.user.count({ where: { role: "STUDENT", NOT: { email: { contains: "@" } } } }),
  ]);

  return {
    totalStudents,
    alreadyBare,
    convertible: rows.filter((r) => !r.collides),
    blocked: rows.filter((r) => r.collides),
  };
}

/**
 * Performs the conversion. One statement, so the whole set moves or none of
 * it does. Returns the number of rows actually updated.
 */
export async function applyStudentUsernameBackfill(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRawUnsafe(`
    UPDATE "User"
    SET "email" = lower("User"."rollNumber")
    WHERE ${CONVERTIBLE}
      AND ${NO_COLLISION}
  `);
}
