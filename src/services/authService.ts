import bcrypt from "bcryptjs";
import type { PrismaClient, Role } from "@prisma/client";
import { signToken, revocationCutoffSeconds } from "../lib/jwt.js";
import { ApiError } from "../middleware/errorHandler.js";
import { assertPasswordStrength, generateTemporaryPassword } from "./passwordPolicy.js";

/**
 * Cost factor for every hash this service writes. Matches what the roster
 * import and seed scripts already use, so a student's hash does not silently
 * get weaker the moment they set their own password.
 */
const BCRYPT_COST = 12;

/**
 * Everything an authenticated request needs to know about the caller, fetched
 * in ONE indexed primary-key lookup per request.
 *
 * The identity columns (name/email/rollNumber) ride along not because the
 * middleware needs them but because GET /auth/me does — carrying them here
 * turns what would be a second round trip into zero extra cost, since the row
 * is already being read and returned over the same connection.
 */
const sessionUserSelect = {
  id: true,
  role: true,
  kitchen: true,
  name: true,
  email: true,
  rollNumber: true,
  isActive: true,
  mustChangePassword: true,
  tokensValidFrom: true,
} as const;

export type SessionUser = {
  id: string;
  role: Role;
  kitchen: string | null;
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
export async function loadSessionUser(prisma: PrismaClient, userId: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: sessionUserSelect,
  });
  return user as SessionUser | null;
}

export async function login(prisma: PrismaClient, jwtSecret: string, identifier: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { rollNumber: identifier }] },
  });
  if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

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
  prisma: PrismaClient,
  jwtSecret: string,
  userId: string,
  currentPassword: string,
  newPassword: string
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
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

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      mustChangePassword: false,
      // Kills every token minted before the cutoff. If this password change was
      // a response to "someone else knows my password", that someone is logged
      // out by this write and cannot get back in.
      tokensValidFrom: new Date(cutoffSeconds * 1000),
    },
  });

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
export async function logoutEverywhere(prisma: PrismaClient, userId: string) {
  const cutoff = new Date(revocationCutoffSeconds() * 1000);
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { tokensValidFrom: cutoff },
    });
  } catch (err: any) {
    if (err?.code === "P2025") throw new ApiError(404, "NOT_FOUND", "User not found");
    throw err;
  }
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
 * There is deliberately no email link. Student addresses are synthesised as
 * <rollNumber>@klh.edu.in and no mail is deliverable to them, so an emailed
 * token would be a reset flow that silently never completes. The counter is
 * the out-of-band channel instead: the student turns up with their ID card,
 * the admin issues a one-time temporary password, and mustChangePassword
 * forces them onto a secret the admin does not know before they can order.
 *
 * The temporary password is returned exactly once, in this response body, and
 * is never recoverable afterwards.
 */
export async function adminResetPassword(
  prisma: PrismaClient,
  actor: { id: string; role: Role },
  input: AdminResetInput
) {
  const where = input.userId
    ? { id: input.userId }
    : input.rollNumber
      ? { rollNumber: input.rollNumber }
      : input.email
        ? { email: input.email }
        : null;
  if (!where) {
    throw new ApiError(400, "MISSING_TARGET", "Provide one of userId, rollNumber or email.");
  }

  const target = await prisma.user.findFirst({
    where,
    select: { id: true, role: true, name: true, email: true, rollNumber: true },
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
  await prisma.user.update({
    where: { id: target.id },
    data: {
      passwordHash,
      mustChangePassword: true,
      // A reset is also a revocation: whoever was riding the old password's
      // sessions is signed out at the same moment the password stops working.
      tokensValidFrom: new Date(revocationCutoffSeconds() * 1000),
    },
  });

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
