import bcrypt from "bcryptjs";
import type { Kitchen, Prisma, PrismaClient, Role } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";
import { revocationCutoffSeconds } from "../lib/jwt.js";

/**
 * `passwordHash` is deliberately absent. `tokensValidFrom` is present because
 * an admin looking at a deactivated account needs to see that the revocation
 * cutoff actually moved — "deactivated but sessions still live" is exactly the
 * failure this feature exists to prevent.
 */
const userSelect = {
  id: true,
  role: true,
  rollNumber: true,
  email: true,
  name: true,
  kitchen: true,
  createdAt: true,
  isActive: true,
  mustChangePassword: true,
  tokensValidFrom: true,
} as const;

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

function buildUserWhere(options: UserPageOptions): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (options.role) and.push({ role: options.role });
  if (options.isActive !== undefined) and.push({ isActive: options.isActive });

  const search = options.search?.trim();
  if (search) {
    and.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { rollNumber: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  return and.length ? { AND: and } : {};
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
export async function listUsers(prisma: PrismaClient, options: UserPageOptions = {}) {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_USER_PAGE_SIZE)),
    MAX_USER_PAGE_SIZE,
  );

  const where = buildUserWhere(options);
  const and: Prisma.UserWhereInput[] = [where];

  if (options.cursor) {
    const { createdAt, id } = decodeUserCursor(options.cursor);
    // Strictly "after" the cursor row in (createdAt DESC, id DESC) order.
    and.push({
      OR: [{ createdAt: { lt: createdAt } }, { AND: [{ createdAt }, { id: { lt: id } }] }],
    });
  }

  // One extra row is fetched purely to answer "is there another page?" without
  // a second COUNT query over the same predicate.
  const rows = await prisma.user.findMany({
    where: { AND: and },
    select: userSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page,
    nextCursor: hasMore && last ? encodeUserCursor(last) : null,
    hasMore,
  };
}

/** Exact size of a filter's result set, for the preview/count affordances. */
export async function countUsers(prisma: PrismaClient, options: UserPageOptions = {}) {
  return prisma.user.count({ where: buildUserWhere(options) });
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
}

export async function createUser(prisma: PrismaClient, input: CreateUserInput) {
  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    return await prisma.user.create({
      data: {
        role: input.role,
        name: input.name,
        email: input.email,
        passwordHash,
        rollNumber: input.rollNumber,
        kitchen: input.role === "ADMIN" ? input.kitchen : undefined,
      },
      select: userSelect,
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
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
}

export async function updateUser(prisma: PrismaClient, id: string, input: UpdateUserInput) {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.role !== undefined) data.role = input.role;
  if (input.kitchen !== undefined) data.kitchen = input.kitchen;
  if (input.password) data.passwordHash = await bcrypt.hash(input.password, 10);

  try {
    return await prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });
  } catch (err: any) {
    if (err?.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    throw err;
  }
}

export async function deleteUser(prisma: PrismaClient, id: string, actorId: string) {
  if (id === actorId) {
    throw new ApiError(400, "CANNOT_DELETE_SELF", "You cannot delete your own account");
  }

  // Order.studentId is onDelete: Restrict, so this delete would fail anyway —
  // but it fails with a raw constraint error that tells the admin nothing. A
  // student who has ever ordered is a deactivation, not a deletion: their rows
  // are the canteen's sales history.
  const orderCount = await prisma.order.count({ where: { studentId: id } });
  if (orderCount > 0) {
    throw new ApiError(
      409,
      "USER_HAS_ORDERS",
      `Cannot delete a user with ${orderCount} existing order(s) — deactivate them instead to preserve order history`,
    );
  }

  try {
    await prisma.user.delete({ where: { id } });
  } catch (err: any) {
    if (err?.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    if (err?.code === "P2003" || err?.code === "P2014") {
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
  prisma: PrismaClient,
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

  const found = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, email: true, name: true, role: true, rollNumber: true, isActive: true },
  });
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
    await prisma.user.updateMany({
      where: { id: { in: targets.map((u) => u.id) } },
      data: active ? { isActive: true } : { isActive: false, tokensValidFrom: cutoff! },
    });
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
