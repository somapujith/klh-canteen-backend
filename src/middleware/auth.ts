import type { Context, MiddlewareHandler } from "hono";
import type { Role } from "@prisma/client";
import { isTokenRevoked, verifyToken } from "../lib/jwt.js";
import { getBindings, getRequestPrisma } from "../lib/context.js";
import { loadSessionUser, type SessionUser } from "../services/authService.js";
import { ApiError } from "./errorHandler.js";
import type { AppEnv } from "../types.js";

/**
 * Authentication, in two halves.
 *
 * 1. The token proves *who* is calling. That part is pure signature checking
 *    and costs nothing.
 * 2. The database says whether that identity is still allowed to call. A JWT
 *    is a 12-hour snapshot and cannot answer this: the account may have been
 *    deleted, deactivated, or had every session revoked since it was signed.
 *    Skipping step 2 is exactly why a wiped account was observed still
 *    ordering — its token was, and remained, perfectly valid.
 *
 * COST OF STEP 2. It is one extra query per authenticated request: a primary
 * key lookup with a nine-column select, on the request's existing Prisma
 * client and connection. Three things keep it from mattering:
 *
 *   - It is memoized on the request context, so a route that stacks a
 *     router-level and a route-level requireAuth() still reads once.
 *   - The select carries the identity columns as well, which lets GET
 *     /auth/me answer from this row instead of issuing a second query.
 *   - Almost every authenticated route already runs 1-4 Prisma queries over
 *     the same connection, so this is one more round trip on a warm socket,
 *     not a new connection.
 *
 * The alternative — caching the row in the isolate for a few seconds — was
 * rejected on purpose. It would buy a small amount of latency in exchange for
 * a window in which a deactivated student keeps ordering, which is the precise
 * failure this middleware exists to close.
 */

export interface AuthOptions {
  /** Empty means "any authenticated role". SUPERADMIN always passes. */
  roles?: Role[];
  /**
   * Let a user flagged `mustChangePassword` through.
   *
   * Reserved for the handful of endpoints that let them clear the flag
   * (change-password, logout, /auth/me). Everything else — ordering above all
   * — must leave this false, which is what makes the gate server-side rather
   * than a screen the frontend chooses to show.
   */
  allowPasswordChange?: boolean;
}

function extractToken(c: Context<AppEnv>): string {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  // EventSource cannot set headers, so SSE clients pass the token in the query
  // string — see routes/events.ts.
  return c.req.query("token") ?? "";
}

/** Whether the forced-change gate is armed. Enforced unless explicitly "false". */
function passwordChangeEnforced(c: Context<AppEnv>): boolean {
  const { ENFORCE_PASSWORD_CHANGE } = getBindings(c);
  if (typeof ENFORCE_PASSWORD_CHANGE !== "string") return true;
  return ENFORCE_PASSWORD_CHANGE.trim().toLowerCase() !== "false";
}

async function resolveSessionUser(c: Context<AppEnv>, userId: string): Promise<SessionUser | null> {
  const memo = c.get("sessionUser");
  if (memo && memo.id === userId) return memo;

  const user = await loadSessionUser(getRequestPrisma(c), userId);
  if (user) c.set("sessionUser", user);
  return user;
}

export function requireAuthWith(options: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  const roles = options.roles ?? [];

  return async (c, next) => {
    const token = extractToken(c);
    if (!token) {
      throw new ApiError(401, "NO_TOKEN", "Missing authorization token");
    }

    // Signature/expiry only. Kept in its own try so that a database problem
    // further down surfaces as a 500 rather than being misreported as a bad
    // token, which would send clients into a pointless re-login loop.
    let payload;
    try {
      const { JWT_SECRET } = getBindings(c);
      payload = verifyToken(token, JWT_SECRET);
    } catch {
      throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token");
    }

    const user = await resolveSessionUser(c, payload.sub);

    // The account is gone. Its token is still cryptographically valid and will
    // stay that way for up to 12 hours; this is the check that stops it.
    if (!user) {
      throw new ApiError(401, "USER_NOT_FOUND", "Account no longer exists");
    }
    if (!user.isActive) {
      throw new ApiError(401, "ACCOUNT_DEACTIVATED", "This account has been deactivated");
    }
    if (isTokenRevoked(payload.iat!, user.tokensValidFrom)) {
      throw new ApiError(401, "TOKEN_REVOKED", "This session has been signed out. Please sign in again.");
    }

    // Role comes from the database row, not the token, so a role change takes
    // effect on the next request instead of at the next login.
    if (roles.length > 0 && !roles.includes(user.role) && user.role !== "SUPERADMIN") {
      throw new ApiError(403, "FORBIDDEN", "Insufficient role");
    }

    if (user.mustChangePassword && !options.allowPasswordChange && passwordChangeEnforced(c)) {
      throw new ApiError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "You must set your own password before you can use this account."
      );
    }

    c.set("user", {
      id: user.id,
      role: user.role,
      kitchen: user.kitchen,
      mustChangePassword: user.mustChangePassword,
    });
    await next();
  };
}

/**
 * Standard gate for every protected route in the app.
 *
 * Blocking flagged users HERE, rather than route by route, is deliberate: it
 * makes the forced password change fail closed. A new route added tomorrow is
 * covered the moment it calls requireAuth(), and nobody has to remember to
 * bolt a second middleware onto it.
 */
export function requireAuth(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return requireAuthWith({ roles });
}

/**
 * The narrow exception: authenticated, but tolerant of a pending password
 * change. Only routes that help the user clear the flag may use this.
 */
export function requireAuthAllowPasswordChange(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return requireAuthWith({ roles, allowPasswordChange: true });
}
