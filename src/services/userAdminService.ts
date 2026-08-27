import bcrypt from "bcryptjs";
import type { Pool } from "@neondatabase/serverless";
import { raw as rawSql, sql, joinSql } from "../db/sql.js";
import type { SqlFragment } from "../db/sql.js";
import { WhereBuilder } from "../db/where.js";
import * as userRepo from "../db/userRepo.js";
import { isUniqueViolation, isForeignKeyViolation } from "../db/errors.js";
import type { Kitchen, Role, School, User } from "../db/schema.js";
import { ApiError } from "../middleware/errorHandler.js";
import { revocationCutoffSeconds } from "../lib/jwt.js";

/**
 * The public shape of a User row — `passwordHash` deliberately absent.
 * `tokensValidFrom` is present because an admin looking at a deactivated
 * account needs to see that the revocation cutoff actually moved —
 * "deactivated but sessions still live" is exactly the failure this feature
 * exists to prevent.
 */
export type SafeUser = Omit<User, "passwordHash">;

function toSafeUser(user: User): SafeUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

/**
 * Accounts that bulk and cohort deactivation refuse to touch, whatever the
 * filter matched. The three staff logins are the only way back into the admin
 * UI, and `student@klh.edu.in` is the shared demo/load-test account whose roll
 * number (2400000001) shares the "24" intake prefix with the entire real
 * student roster — so the single most natural cohort selection would sweep it
 * up. Single-account deactivation by explicit id is still allowed; this guard
 * only covers operations where the caller named a *filter*, not a person.
 */
export const PROTECTED_ACCOUNT_EMAILS: readonly string[] = [
  "superadmin@klh.edu.in",
  "snacks_admin@klh.edu.in",
  "meals_admin@klh.edu.in",
  "student@klh.edu.in",
];

const PROTECTED_EMAIL_SET = new Set(PROTECTED_ACCOUNT_EMAILS.map((e) => e.toLowerCase()));

export function isProtectedAccount(email: string): boolean {
  return PROTECTED_EMAIL_SET.has(email.toLowerCase());
}

// ---------------------------------------------------------------------------
// Cursor-paginated, searchable listing
// ---------------------------------------------------------------------------

/** Page size when the caller does not ask for one. */
export const DEFAULT_USER_PAGE_SIZE = 50;
/** Hard ceiling — `?limit=100000` must not reintroduce the unbounded scan. */
export const MAX_USER_PAGE_SIZE = 200;
/** Most ids a single bulk activate/deactivate call may name. */
export const MAX_BULK_USER_IDS = 500;

export interface UserPageOptions {
  role?: Role;
  /** Undefined means "both" — the pre-existing behaviour of showing everyone. */
  isActive?: boolean;
  /** Free text, matched case-insensitively against name, rollNumber and email. */
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface UserPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Keyset cursor over this list's sort key, (createdAt DESC, id DESC).
 *
 * Same construction as the kitchen board's cursor in orderService — keyset
 * rather than OFFSET because accounts are created while an admin is paging
 * (a roster import mid-scroll would shift every later page by 150 rows and
 * silently hide students). `id` is the tiebreaker: a bulk import gives many
 * users an identical createdAt, so createdAt alone would drop or repeat rows.
 */
export function encodeUserCursor(user: { createdAt: Date; id: string }): string {
  return Buffer.from(`${user.createdAt.toISOString()}|${user.id}`).toString("base64url");
}

export function decodeUserCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.indexOf("|");
  if (sep === -1) throw new ApiError(400, "INVALID_CURSOR", "Malformed pagination cursor");

  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new ApiError(400, "INVALID_CURSOR", "Malformed pagination cursor");
  }
  return { createdAt, id };
}

function buildUserWhere(options: UserPageOptions): WhereBuilder {
  const wb = new WhereBuilder();
  wb.andIf(options.role, '"role" = $1::"Role"');
  wb.andIf(options.isActive, '"isActive" = $1');

  const search = options.search?.trim();
  if (search) {
    wb.and('("name" ILIKE $1 OR "rollNumber" ILIKE $1 OR "email" ILIKE $1)', `%${search}%`);
  }

  return wb;
}

/**
 * The admin Users page feed.
 *
 * Previously `findMany()` with no `where` and no `take`: every account, every
 * column in `userSelect`, on every page load. At the 500-600 students this
 * canteen is sized for that is the whole table in one response. Now bounded by
 * a cursor page of at most MAX_USER_PAGE_SIZE, and narrowable by role, active
 * state and free-text search so an admin can find one leaver without paging
 * through the intake.
 */
export async function listUsers(pool: Pool, options: UserPageOptions = {}): Promise<UserPage<SafeUser>> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_USER_PAGE_SIZE)),
    MAX_USER_PAGE_SIZE,
  );

  const wb = buildUserWhere(options);
  if (options.cursor) {
    const { createdAt, id } = decodeUserCursor(options.cursor);
    // Strictly "after" the cursor row in (createdAt DESC, id DESC) order.
    wb.and('("createdAt", "id") < ($1, $2)', createdAt, id);
  }

  // One extra row is fetched purely to answer "is there another page?" without
  // a second COUNT query over the same predicate.
  const rows = await userRepo.findMany(pool, wb.build(), rawSql('"createdAt" DESC, "id" DESC'), limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page.map(toSafeUser),
    nextCursor: hasMore && last ? encodeUserCursor(last) : null,
    hasMore,
  };
}

/** Exact size of a filter's result set, for the preview/count affordances. */
export async function countUsers(pool: Pool, options: UserPageOptions = {}): Promise<number> {
  return userRepo.count(pool, buildUserWhere(options).build());
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

interface CreateUserInput {
  role: Role;
  name: string;
  email: string;
  password: string;
  rollNumber?: string;
  kitchen?: Kitchen;
  school: School;
}

export async function createUser(pool: Pool, input: CreateUserInput): Promise<SafeUser> {
  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    const user = await userRepo.insert(pool, {
      role: input.role,
      name: input.name,
      email: input.email,
      passwordHash,
      rollNumber: input.rollNumber,
      kitchen: input.role === "ADMIN" ? input.kitchen : undefined,
      school: input.school,
    });
    return toSafeUser(user);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, "EMAIL_TAKEN", "A user with this email already exists");
    }
    throw err;
  }
}

interface UpdateUserInput {
  name?: string;
  kitchen?: Kitchen | null;
  role?: Role;
  password?: string;
  school?: School;
}

export async function updateUser(pool: Pool, id: string, input: UpdateUserInput): Promise<SafeUser> {
  const sets: SqlFragment[] = [];
  if (input.name !== undefined) sets.push(sql`"name" = ${input.name}`);
  if (input.role !== undefined) sets.push(sql`"role" = ${input.role}::"Role"`);
  if (input.kitchen !== undefined) sets.push(sql`"kitchen" = ${input.kitchen}::"Kitchen"`);
  if (input.school !== undefined) sets.push(sql`"school" = ${input.school}::"School"`);
  if (input.password) {
    const passwordHash = await bcrypt.hash(input.password, 10);
    sets.push(sql`"passwordHash" = ${passwordHash}`);
  }

  // updateFields() 404s via assertAffected() — same outcome as the old
  // P2025 catch, without needing one. An empty `sets` (a body with no
  // recognised fields) skips the UPDATE entirely rather than running an
  // empty SET clause — Prisma's update({data:{}}) was a no-op-but-still-a-
  // write; this is a no-op-and-no-write, same observable result.
  if (sets.length === 0) {
    const user = await userRepo.findById(pool, id);
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");
    return toSafeUser(user);
  }

  const user = await userRepo.updateFields(pool, id, joinSql(sets));
  return toSafeUser(user);
}

export async function deleteUser(pool: Pool, id: string, actorId: string): Promise<void> {
  if (id === actorId) {
    throw new ApiError(400, "CANNOT_DELETE_SELF", "You cannot delete your own account");
  }

  // Order.studentId is onDelete: Restrict, so this delete would fail anyway —
  // but it fails with a raw constraint error that tells the admin nothing. A
  // student who has ever ordered is a deactivation, not a deletion: their rows
  // are the canteen's sales history.
  const orderCount = await userRepo.countOrdersByStudent(pool, id);
  if (orderCount > 0) {
    throw new ApiError(
      409,
      "USER_HAS_ORDERS",
      `Cannot delete a user with ${orderCount} existing order(s) — deactivate them instead to preserve order history`,
    );
  }

  try {
    // deleteById() 404s via assertAffected() — same outcome as the old
    // P2025 catch.
    await userRepo.deleteById(pool, id);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new ApiError(409, "USER_HAS_ORDERS", "Cannot delete a user with existing orders");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Deactivate / reactivate
// ---------------------------------------------------------------------------

/**
 * A revocation cutoff strictly newer than every token already in circulation.
 * Deactivation without this only stops the *next* login — the leaver's current
 * 12-hour token keeps ordering until it expires. See lib/jwt.ts.
 */
export function deactivationCutoff(now: number = Date.now()): Date {
  return new Date(revocationCutoffSeconds(now) * 1000);
}

export type SkipReason =
  | "not_found"
  | "already_in_state"
  | "self"
  | "protected_account"
  | "superadmin";

export interface SetActiveSkip {
  id: string;
  email?: string;
  reason: SkipReason;
}

export interface SetActiveResult {
  active: boolean;
  requested: number;
  changed: number;
  /** ISO cutoff written to tokensValidFrom. Null on reactivation. */
  tokensValidFrom: string | null;
  changedUsers: { id: string; email: string; rollNumber: string | null; name: string }[];
  skipped: SetActiveSkip[];
}

interface SetActiveOptions {
  /** Bypasses the PROTECTED_ACCOUNT_EMAILS guard. Never true for filter-driven ops. */
  allowProtected?: boolean;
  /**
   * Raises the id ceiling for callers that have already bounded the set
   * themselves — cohort promotion resolves its own ids from a roll-number
   * prefix and an intake is legitimately larger than a hand-picked selection.
   */
  maxIds?: number;
}

/**
 * Flips `isActive` on a set of accounts, and on deactivation moves
 * `tokensValidFrom` forward so the account's live sessions die with it. The
 * two writes are one statement precisely because a deactivation that half
 * applied would leave a "disabled" student still holding a working token.
 *
 * Reactivation deliberately leaves `tokensValidFrom` where deactivation put
 * it: the old tokens are gone for good and the returning student logs in
 * again. Rewinding the cutoff would resurrect every token issued before the
 * deactivation, including any that leaked while the account was disabled.
 *
 * Nothing is deleted, ever. Order history is the canteen's books.
 */
export async function setUsersActive(
  pool: Pool,
  ids: string[],
  active: boolean,
  actorId: string,
  options: SetActiveOptions = {},
): Promise<SetActiveResult> {
  const unique = [...new Set(ids)];
  const maxIds = options.maxIds ?? MAX_BULK_USER_IDS;
  if (unique.length === 0) {
    throw new ApiError(400, "NO_USERS", "No user ids supplied");
  }
  if (unique.length > maxIds) {
    throw new ApiError(400, "TOO_MANY_USERS", `At most ${maxIds} users may be changed in one call`);
  }

  const found = await userRepo.findManyByIds(pool, unique);
  const byId = new Map(found.map((u) => [u.id, u]));

  const skipped: SetActiveSkip[] = [];
  const targets: typeof found = [];

  for (const id of unique) {
    const user = byId.get(id);
    if (!user) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (user.isActive === active) {
      skipped.push({ id, email: user.email, reason: "already_in_state" });
      continue;
    }
    if (!active) {
      if (id === actorId) {
        skipped.push({ id, email: user.email, reason: "self" });
        continue;
      }
      if (user.role === "SUPERADMIN") {
        skipped.push({ id, email: user.email, reason: "superadmin" });
        continue;
      }
      if (!options.allowProtected && isProtectedAccount(user.email)) {
        skipped.push({ id, email: user.email, reason: "protected_account" });
        continue;
      }
    }
    targets.push(user);
  }

  const cutoff = active ? null : deactivationCutoff();

  if (targets.length > 0) {
    await userRepo.setActiveByIds(pool, targets.map((u) => u.id), active, cutoff);
  }

  return {
    active,
    requested: unique.length,
    changed: targets.length,
    tokensValidFrom: cutoff ? cutoff.toISOString() : null,
    changedUsers: targets.map((u) => ({
      id: u.id,
      email: u.email,
      rollNumber: u.rollNumber,
      name: u.name,
    })),
    skipped,
  };
}
