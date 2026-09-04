import bcrypt from "bcryptjs";
import type { Pool } from "@neondatabase/serverless";
import { sql, joinSql } from "../db/sql.js";
import * as userRepo from "../db/userRepo.js";
import type { Role, School } from "../db/schema.js";
import { signToken, revocationCutoffSeconds } from "../lib/jwt.js";
import { ApiError } from "../middleware/errorHandler.js";
import { assertPasswordStrength, generateTemporaryPassword } from "./passwordPolicy.js";
import { LEGACY_STUDENT_EMAIL_DOMAIN } from "./studentRosterService.js";

/**
 * Cost factor for every hash this service writes. Matches what the roster
 * import and seed scripts already use, so a student's hash does not silently
 * get weaker the moment they set their own password.
 *
 * Lowered from 12: bcryptjs is a pure-JS implementation (Workers can't use
 * native bindings), and cost 12 was adding several hundred ms of CPU-bound
 * compare time to every login on top of the request's other costs. 10 still
 * clears OWASP's minimum recommended work factor.
 */
const BCRYPT_COST = 10;

export type SessionUser = {
  id: string;
  role: Role;
  kitchen: string | null;
  school: School;
  name: string;
  email: string;
  rollNumber: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  tokensValidFrom: Date | null;
};

/**
 * The per-request account read behind token revocation.
 *
 * A JWT alone can only ever describe the world as it was up to 12 hours ago,
 * which is exactly the bug this replaces: a deleted account kept ordering
 * because nothing ever asked the database whether it still existed. Returns
 * null when the row is gone.
 */
export async function loadSessionUser(pool: Pool, userId: string): Promise<SessionUser | null> {
  const user = await userRepo.findById(pool, userId);
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    kitchen: user.kitchen,
    school: user.school,
    name: user.name,
    email: user.email,
    rollNumber: user.rollNumber,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    tokensValidFrom: user.tokensValidFrom,
  };
}

const LEGACY_SUFFIX = `@${LEGACY_STUDENT_EMAIL_DOMAIN}`;

/**
 * The identifiers a single typed login string may stand for, most literal
 * first.
 *
 * Student usernames used to be stored as `<roll>@klh.edu.in` and are now
 * stored bare, so during (and after) the backfill a student may type either
 * form and both have to work: their browser has the old one saved, the class
 * roster shows the new one. Stripping a trailing `@klh.edu.in` covers that.
 *
 * ORDER MATTERS AND THE LIST IS NOT MERGED INTO ONE QUERY. The identifier as
 * typed is resolved on its own first, and the stripped form is only consulted
 * when nothing matched it. A single `OR` over both forms could, in principle,
 * hand back whichever row Postgres reached first when two accounts each match
 * a different arm — an exact-match-wins ordering makes that impossible, and
 * means no account that logs in today can start resolving to a different one.
 */
export function loginIdentifierCandidates(identifier: string): string[] {
  const typed = identifier.trim();
  if (!typed) return [];

  const candidates = [typed];
  if (typed.toLowerCase().endsWith(LEGACY_SUFFIX)) {
    const local = typed.slice(0, -LEGACY_SUFFIX.length);
    if (local) candidates.push(local);
  }
  return candidates;
}

export async function login(
  pool: Pool,
  jwtSecret: string,
  identifier: string,
  password: string,
  school: School,
) {
  const [typed, legacyStripped] = loginIdentifierCandidates(identifier);

  let user = typed ? await userRepo.findFirstByEmailOrRollNumber(pool, typed) : null;

  if (!user && legacyStripped) {
    // Scoped to STUDENT: `<roll>@klh.edu.in` was only ever a *student*
    // username. A staff address like superadmin@klh.edu.in already matched
    // above; letting its local part ("superadmin") reach a second lookup that
    // could match any role would be handing an attacker a free alias.
    user = await userRepo.findFirstByEmailOrRollNumber(pool, legacyStripped, { role: "STUDENT" });
  }

  if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  // Transparent migration off the old cost-12 hashes: the password is only
  // ever available in plaintext right here, so this is the one place a
  // stale hash can be upgraded (well, downgraded — see BCRYPT_COST) without
  // forcing a reset. Every login after this one for the same user compares
  // against the cheaper hash instead.
  const hashCost = Number(user.passwordHash.match(/^\$2[aby]\$(\d+)\$/)?.[1]);
  if (hashCost && hashCost !== BCRYPT_COST) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await userRepo.updateFields(pool, user.id, sql`"passwordHash" = ${passwordHash}`);
  }

  // Checked only after the password, with the SAME generic message as a wrong
  // password: a distinct "wrong school" error would let anyone holding a
  // correct password enumerate which school an account actually belongs to.
  if (user.school !== school) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  // Checked only after the password, so a wrong password and a deactivated
  // account are indistinguishable to someone who does not already hold the
  // credentials — otherwise this endpoint becomes a roster of who has left.
  if (!user.isActive) {
    throw new ApiError(403, "ACCOUNT_DEACTIVATED", "This account has been deactivated. Contact the canteen office.");
  }

  const token = signToken({ sub: user.id, role: user.role, kitchen: user.kitchen }, jwtSecret);
  return {
    token,
    role: user.role,
    name: user.name,
    kitchen: user.kitchen,
    id: user.id,
    /**
     * Which institution this account belongs to. The client needs it to know
     * whether school-scoped features apply — stock requests are KLH-only. It
     * gates the UI only; every endpoint re-checks server-side, since a
     * response field is not an authorisation decision.
     */
    school: user.school,
    /**
     * Login deliberately still succeeds for a flagged user. The token they get
     * back is a *restricted* one in effect, not in shape: requireAuth() refuses
     * it everywhere except the change-password endpoints, so the only thing
     * they can do with it is fix the problem. Issuing no token at all would
     * leave them unable to authenticate to the change-password call itself.
     */
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Student-initiated password change. Requires the current password — an
 * attacker who has stolen a live token still cannot take the account over,
 * and the forced-change flow cannot be used to lock a classmate out.
 *
 * Returns a replacement token, because the same operation revokes every token
 * issued before now (including the caller's own). Handing the new one back is
 * what keeps "change your password" from also meaning "and now log in again".
 */
export async function changeOwnPassword(
  pool: Pool,
  jwtSecret: string,
  userId: string,
  currentPassword: string,
  newPassword: string
) {
  const user = await userRepo.findById(pool, userId);
  if (!user) throw new ApiError(401, "USER_NOT_FOUND", "Account no longer exists");
  if (!user.isActive) {
    throw new ApiError(403, "ACCOUNT_DEACTIVATED", "This account has been deactivated.");
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }
  if (currentPassword === newPassword) {
    throw new ApiError(400, "WEAK_PASSWORD", "New password must be different from your current password.");
  }
  assertPasswordStrength(newPassword, {
    rollNumber: user.rollNumber,
    email: user.email,
    name: user.name,
  });

  const cutoffSeconds = revocationCutoffSeconds();
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

  await userRepo.updateFields(
    pool,
    userId,
    joinSql([
      sql`"passwordHash" = ${passwordHash}`,
      sql`"mustChangePassword" = ${false}`,
      // Kills every token minted before the cutoff. If this password change was
      // a response to "someone else knows my password", that someone is logged
      // out by this write and cannot get back in.
      sql`"tokensValidFrom" = ${new Date(cutoffSeconds * 1000)}`,
    ]),
  );

  const token = signToken(
    { sub: user.id, role: user.role, kitchen: user.kitchen },
    jwtSecret,
    { iatSeconds: cutoffSeconds }
  );
  return { token, role: user.role, name: user.name, kitchen: user.kitchen, id: user.id, mustChangePassword: false };
}

/**
 * Logout-everywhere. Moves the revocation cutoff forward, which invalidates
 * every outstanding token for this user — the current one included. There is
 * no replacement token: signing out is supposed to sign you out.
 */
export async function logoutEverywhere(pool: Pool, userId: string) {
  const cutoff = new Date(revocationCutoffSeconds() * 1000);
  // updateFields 404s via assertAffected() if the row is gone — no try/catch
  // needed, unlike the old P2025 check.
  await userRepo.updateFields(pool, userId, sql`"tokensValidFrom" = ${cutoff}`);
  return { revokedBefore: cutoff.toISOString() };
}

/**
 * Who may reset whom.
 *
 * An ADMIN resetting another ADMIN (or a SUPERADMIN) would be a one-step
 * privilege escalation: set a temporary password, then log in as them. Kitchen
 * admins therefore reach students only. A SUPERADMIN can additionally reset
 * admins, but not another SUPERADMIN and not themselves — peer resets between
 * top-level accounts have no separation of duties left to protect them, and
 * self-reset is what /auth/change-password is for.
 */
function assertMayReset(actorRole: Role, actorId: string, target: { id: string; role: Role }): void {
  if (target.id === actorId) {
    throw new ApiError(400, "CANNOT_RESET_SELF", "Use /auth/change-password to change your own password.");
  }
  if (actorRole === "SUPERADMIN") {
    if (target.role === "SUPERADMIN") {
      throw new ApiError(403, "FORBIDDEN", "A superadmin cannot reset another superadmin's password.");
    }
    return;
  }
  if (actorRole === "ADMIN") {
    if (target.role !== "STUDENT") {
      throw new ApiError(403, "FORBIDDEN", "Admins can only reset student passwords.");
    }
    return;
  }
  throw new ApiError(403, "FORBIDDEN", "Insufficient role");
}

export interface AdminResetInput {
  userId?: string;
  rollNumber?: string;
  email?: string;
  /** Optional operator-chosen temp password; one is generated when absent. */
  temporaryPassword?: string;
}

/**
 * Admin-mediated password reset — the self-service path for a student who has
 * forgotten their password.
 *
 * There is deliberately no email link. A student's `email` column holds their
 * roll number, not an address — it is a username — and no mail is deliverable
 * to them at all, so an emailed token would be a reset flow that silently
 * never completes. The counter is
 * the out-of-band channel instead: the student turns up with their ID card,
 * the admin issues a one-time temporary password, and mustChangePassword
 * forces them onto a secret the admin does not know before they can order.
 *
 * The temporary password is returned exactly once, in this response body, and
 * is never recoverable afterwards.
 */
export async function adminResetPassword(
  pool: Pool,
  actor: { id: string; role: Role },
  input: AdminResetInput
) {
  if (!input.userId && !input.rollNumber && !input.email) {
    throw new ApiError(400, "MISSING_TARGET", "Provide one of userId, rollNumber or email.");
  }

  const target = await userRepo.findByIdOrRollOrEmail(pool, {
    id: input.userId,
    rollNumber: input.rollNumber,
    email: input.email,
  });
  if (!target) throw new ApiError(404, "NOT_FOUND", "User not found");

  assertMayReset(actor.role, actor.id, target);

  const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();
  // An operator-supplied temp password goes through the same strength gate as
  // a student-chosen one, so "reset them all to klh@123" is not reachable.
  assertPasswordStrength(temporaryPassword, {
    rollNumber: target.rollNumber,
    email: target.email,
    name: target.name,
  });

  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
  await userRepo.updateFields(
    pool,
    target.id,
    joinSql([
      sql`"passwordHash" = ${passwordHash}`,
      sql`"mustChangePassword" = ${true}`,
      // A reset is also a revocation: whoever was riding the old password's
      // sessions is signed out at the same moment the password stops working.
      sql`"tokensValidFrom" = ${new Date(revocationCutoffSeconds() * 1000)}`,
    ]),
  );

  return {
    userId: target.id,
    name: target.name,
    rollNumber: target.rollNumber,
    email: target.email,
    temporaryPassword,
    mustChangePassword: true,
    /** Shown once. There is no endpoint that can return it again. */
    note: "Give this to the student in person. They must set their own password before they can order.",
  };
}
