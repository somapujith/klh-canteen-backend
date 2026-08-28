/**
 * Raw-SQL data access for the "User" table, replacing `prisma.user.*` calls
 * across the User domain (authService, telegramService, studentRosterService,
 * studentImportService, userAdminService, cohortService).
 *
 * Every column of `User` maps 1:1 to a struct field (see src/db/schema.ts's
 * doc comment), so most functions here return the full row and let the
 * caller pick fields in JS — narrower `select`-shaped helpers only exist
 * where the WHERE clause itself differs from a plain by-id lookup (Telegram
 * chat-id / link-code lookups, the login OR-lookup).
 *
 * `Runner` accepts a `Pool` or a `PoolClient` (checked out of a pool inside a
 * transaction) — nothing here needs a transaction today, but the wider union
 * costs nothing and matches src/db/sql.ts's `QueryRunner` shape.
 *
 * `id` has no DB-level default (Prisma's `@default(uuid())` generated
 * client-side, not via a Postgres `DEFAULT`) — every insert here generates
 * one with `crypto.randomUUID()`, the same primitive orderService.ts already
 * uses for Order/OrderItem ids.
 *
 * Enum columns (`role`, `kitchen`) need an explicit `::"Role"` / `::"Kitchen"`
 * cast on any parameter compared or written to them — node-postgres sends
 * parameters as text, and Postgres does not implicitly cast text to a custom
 * enum type in a comparison or insert.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, raw, joinSql, query } from "./sql.js";
import type { SqlFragment } from "./sql.js";
import { assertAffected } from "./errors.js";
import type { Kitchen, Role, School, User } from "./schema.js";

export type Runner = Pool | PoolClient;

const ALL_COLUMNS = raw(`
  "id", "role", "rollNumber", "email", "passwordHash", "name", "kitchen", "school",
  "createdAt", "mustChangePassword", "isActive", "tokensValidFrom",
  "telegramChatId", "telegramUsername", "telegramLinkedAt",
  "telegramLinkCode", "telegramLinkExpiresAt", "googleId", "googleEmail"
`);

// ---------------------------------------------------------------------------
// Single-row lookups
// ---------------------------------------------------------------------------

export async function findById(runner: Runner, id: string): Promise<User | null> {
  const { rows } = await query<User>(runner, sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE "id" = ${id}`);
  return rows[0] ?? null;
}

/**
 * adminResetPassword's target lookup — exactly one of `id`/`rollNumber`/
 * `email` is set by the caller (see authService.ts's `where` construction).
 */
export async function findByIdOrRollOrEmail(
  runner: Runner,
  target: { id?: string; rollNumber?: string; email?: string },
): Promise<User | null> {
  const where = target.id
    ? sql`"id" = ${target.id}`
    : target.rollNumber
      ? sql`"rollNumber" = ${target.rollNumber}`
      : target.email
        ? sql`"email" = ${target.email}`
        : null;
  if (!where) return null;
  const { rows } = await query<User>(runner, sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE ${where} LIMIT 1`);
  return rows[0] ?? null;
}

/**
 * login()'s per-candidate lookup — email-or-rollNumber, optionally scoped to
 * a role. Deliberately a single-candidate lookup, not an OR over multiple
 * identifiers: see the ORDER MATTERS comment on loginIdentifierCandidates()
 * in authService.ts for why the two candidates are resolved as two separate
 * sequential calls rather than merged here.
 */
export async function findFirstByEmailOrRollNumber(
  runner: Runner,
  identifier: string,
  opts: { role?: Role } = {},
): Promise<User | null> {
  const where = opts.role
    ? sql`"role" = ${opts.role}::"Role" AND ("email" = ${identifier} OR "rollNumber" = ${identifier})`
    : sql`"email" = ${identifier} OR "rollNumber" = ${identifier}`;
  const { rows } = await query<User>(runner, sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE ${where} LIMIT 1`);
  return rows[0] ?? null;
}

/** The `NOT { id: student.id }` collision check in handleTelegramUpdate(). */
export async function findByTelegramChatIdExcluding(
  runner: Runner,
  chatId: string,
  excludeId: string,
): Promise<Pick<User, "id"> | null> {
  const { rows } = await query<Pick<User, "id">>(
    runner,
    sql`SELECT "id" FROM "User" WHERE "telegramChatId" = ${chatId} AND "id" <> ${excludeId} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function findStudentByTelegramChatId(
  runner: Runner,
  chatId: string,
): Promise<Pick<User, "rollNumber" | "name"> | null> {
  const { rows } = await query<Pick<User, "rollNumber" | "name">>(
    runner,
    sql`SELECT "rollNumber", "name" FROM "User" WHERE "telegramChatId" = ${chatId} AND "role" = 'STUDENT'::"Role" LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function findStudentByTelegramLinkCode(
  runner: Runner,
  code: string,
): Promise<Pick<User, "id" | "name" | "rollNumber"> | null> {
  const { rows } = await query<Pick<User, "id" | "name" | "rollNumber">>(
    runner,
    sql`
      SELECT "id", "name", "rollNumber" FROM "User"
      WHERE "role" = 'STUDENT'::"Role" AND "telegramLinkCode" = ${code} AND "telegramLinkExpiresAt" > now()
      LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

/** googleAuthService's identity lookup — googleId is the stable key, not email. */
export async function findByGoogleId(runner: Runner, googleId: string): Promise<User | null> {
  const { rows } = await query<User>(
    runner,
    sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE "googleId" = ${googleId} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** studentImportService's per-row duplicate check. */
export async function existsByRollNumberOrEmail(
  runner: Runner,
  rollNumber: string,
  email: string,
): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    runner,
    sql`SELECT EXISTS(SELECT 1 FROM "User" WHERE "rollNumber" = ${rollNumber} OR "email" = ${email}) AS "exists"`,
  );
  return rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------------
// Batch lookups
// ---------------------------------------------------------------------------

export interface RosterExistingRow {
  rollNumber: string | null;
  email: string;
}

/** studentRosterService's whole-file existence check, one round trip. */
export async function findExistingByRollNumbersOrEmails(
  runner: Runner,
  rollNumbers: string[],
  usernames: string[],
  legacyEmails: string[],
): Promise<RosterExistingRow[]> {
  const { rows } = await query<RosterExistingRow>(
    runner,
    sql`
      SELECT "rollNumber", "email" FROM "User"
      WHERE "rollNumber" = ANY(${rollNumbers}::text[])
         OR "email" = ANY(${usernames}::text[])
         OR "email" = ANY(${legacyEmails}::text[])
    `,
  );
  return rows;
}

export async function findManyByIds(runner: Runner, ids: string[]): Promise<User[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<User>(
    runner,
    sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE "id" = ANY(${ids}::text[])`,
  );
  return rows;
}

/**
 * Generic paged/filtered listing. `where`/`orderBy` are caller-built
 * fragments (WhereBuilder for `where`; a `raw(...)` column list for
 * `orderBy`) — used by userAdminService.listUsers (paged, newest-first) and
 * cohortService.loadCohort (roll-number-ordered, unpaged beyond `limit`).
 */
export async function findMany(
  runner: Runner,
  where: SqlFragment,
  orderBy: SqlFragment,
  limit: number,
): Promise<User[]> {
  const { rows } = await query<User>(
    runner,
    sql`SELECT ${ALL_COLUMNS} FROM "User" WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`,
  );
  return rows;
}

export async function count(runner: Runner, where: SqlFragment): Promise<number> {
  const { rows } = await query<{ count: string }>(
    runner,
    sql`SELECT COUNT(*)::bigint AS count FROM "User" WHERE ${where}`,
  );
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface InsertUserInput {
  role: Role;
  name: string;
  email: string;
  passwordHash: string;
  rollNumber?: string | null;
  kitchen?: Kitchen | null;
  school: School;
  mustChangePassword?: boolean;
  googleId?: string | null;
  googleEmail?: string | null;
}

/**
 * General-purpose create. Lets a unique-violation on `email` (or the
 * `rollNumber`/`telegramChatId`/`googleId` unique indexes) propagate —
 * callers map it with `isUniqueViolation()`.
 */
export async function insert(runner: Runner, data: InsertUserInput): Promise<User> {
  const id = crypto.randomUUID();
  const { rows } = await query<User>(
    runner,
    sql`
      INSERT INTO "User" ("id", "role", "name", "email", "passwordHash", "rollNumber", "kitchen", "school", "mustChangePassword", "googleId", "googleEmail")
      VALUES (
        ${id}, ${data.role}::"Role", ${data.name}, ${data.email}, ${data.passwordHash},
        ${data.rollNumber ?? null}, ${data.kitchen ?? null}::"Kitchen", ${data.school}::"School", ${data.mustChangePassword ?? false},
        ${data.googleId ?? null}, ${data.googleEmail ?? null}
      )
      RETURNING ${ALL_COLUMNS}
    `,
  );
  return rows[0];
}

export interface NewStudentRow {
  name: string;
  rollNumber: string;
  email: string;
  passwordHash: string;
}

/**
 * studentRosterService's bulk create — `ON CONFLICT DO NOTHING` on the
 * `email` unique index, replacing Prisma's `createMany({ skipDuplicates:
 * true })`. `fresh` (the caller) has already been filtered against
 * findExistingByRollNumbersOrEmails, so a conflict here means a row was
 * created by a concurrent request between that check and this insert — the
 * same race Prisma's skipDuplicates silently absorbed.
 */
export async function insertStudentsSkipDuplicates(runner: Runner, students: NewStudentRow[]): Promise<void> {
  if (students.length === 0) return;
  const rowsFrag = joinSql(
    students.map(
      (s) =>
        sql`(${crypto.randomUUID()}::text, ${s.name}::text, ${s.rollNumber}::text, ${s.email}::text, ${s.passwordHash}::text)`,
    ),
  );
  await query(
    runner,
    sql`
      INSERT INTO "User" ("id", "name", "rollNumber", "email", "passwordHash", "role", "mustChangePassword")
      SELECT v.id, v.name, v."rollNumber", v.email, v."passwordHash", 'STUDENT'::"Role", TRUE
      FROM (VALUES ${rowsFrag}) AS v(id, name, "rollNumber", email, "passwordHash")
      ON CONFLICT ("email") DO NOTHING
    `,
  );
}

/**
 * Generic `UPDATE ... SET <fragment> WHERE id = ... RETURNING *`, 404s via
 * assertAffected() if the row is gone. Callers build `setFragment` with
 * `joinSql`/`sql` (see authService.changeOwnPassword, userAdminService.updateUser).
 */
export async function updateFields(runner: Runner, id: string, setFragment: SqlFragment): Promise<User> {
  const { rows, rowCount } = await query<User>(
    runner,
    sql`UPDATE "User" SET ${setFragment} WHERE "id" = ${id} RETURNING ${ALL_COLUMNS}`,
  );
  assertAffected(rowCount, "User not found");
  return rows[0];
}

export async function deleteById(runner: Runner, id: string): Promise<void> {
  const { rowCount } = await query(runner, sql`DELETE FROM "User" WHERE "id" = ${id} RETURNING "id"`);
  assertAffected(rowCount, "User not found");
}

/** userAdminService.deleteUser's pre-flight guard — reads the Order table. */
export async function countOrdersByStudent(runner: Runner, studentId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    runner,
    sql`SELECT COUNT(*)::bigint AS count FROM "Order" WHERE "studentId" = ${studentId}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * setUsersActive's one-statement bulk flip. Reactivation touches only
 * `isActive` (see the doc comment on setUsersActive in userAdminService.ts
 * for why `tokensValidFrom` is deliberately left alone on reactivation).
 */
export async function setActiveByIds(
  runner: Runner,
  ids: string[],
  active: boolean,
  tokensValidFrom: Date | null,
): Promise<void> {
  if (ids.length === 0) return;
  const frag = active
    ? sql`UPDATE "User" SET "isActive" = TRUE WHERE "id" = ANY(${ids}::text[])`
    : sql`UPDATE "User" SET "isActive" = FALSE, "tokensValidFrom" = ${tokensValidFrom} WHERE "id" = ANY(${ids}::text[])`;
  await query(runner, frag);
}
