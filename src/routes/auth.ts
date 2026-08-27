import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  login,
  changeOwnPassword,
  logoutEverywhere,
  adminResetPassword,
} from "../services/authService.js";
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } from "../services/passwordPolicy.js";
import { logAction } from "../services/auditService.js";
import { requireAuth, requireAuthAllowPasswordChange } from "../middleware/auth.js";
import { getBindings, getRequestPool } from "../lib/context.js";
import { rateLimit, resetRateLimit } from "../middleware/rateLimit.js";
import type { AppEnv } from "../types.js";

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
  school: z.enum(["KLH", "DRK"]),
});

const LOGIN_LIMIT_PREFIX = "login";
const CHANGE_PASSWORD_LIMIT_PREFIX = "change-password";

/**
 * Login is keyed on the submitted campus ID, never on IP — the whole campus
 * shares one NATed WiFi address, so an IP key would throttle everyone at once
 * and still be trivially sidestepped by switching to mobile data.
 *
 * The flip side of a campus-ID key is that the key is attacker-suppliable:
 * anyone can post a victim's roll number with a wrong password. So this limit
 * MUST NOT be able to refuse a request. It uses progressive delay instead —
 * 5 free attempts per 15 minutes, then 250ms / 500ms / 1s / 2s / 3s (capped)
 * before the response. Guessing at scale becomes hopeless; a student who
 * fumbles their password still gets in, just a few seconds later. There is no
 * attempt count at which a correct password stops working.
 */
const loginLimiter = rateLimit({
  prefix: LOGIN_LIMIT_PREFIX,
  windowSeconds: 15 * 60,
  max: 5,
  strategy: "progressive-delay",
  delay: {
    baseMs: 250,
    maxMs: 3_000,
    // A challenge would become the next friction tier past this many attempts.
    // Inert until a provider is configured — see ProgressiveDelayOptions
    // .onChallengeRequired in src/middleware/rateLimit.ts.
    challengeAfter: 25,
  },
  keyFn: loginIdentity,
  // Retained for interface shape only; progressive-delay never rejects.
  code: "TOO_MANY_LOGIN_ATTEMPTS",
  message: "Too many login attempts, please try again later.",
});

/**
 * change-password takes the CURRENT password, which makes it a second online
 * guessing oracle for anyone holding a stolen token. Same treatment as login,
 * and for the same reason: progressive delay, never refusal. A student who is
 * fumbling their own current password while trying to replace it is the last
 * person who should be locked out.
 */
const changePasswordLimiter = rateLimit({
  prefix: CHANGE_PASSWORD_LIMIT_PREFIX,
  windowSeconds: 15 * 60,
  max: 5,
  strategy: "progressive-delay",
  delay: { baseMs: 250, maxMs: 3_000 },
  code: "TOO_MANY_ATTEMPTS",
  message: "Too many attempts, please try again later.",
});

/** Normalised campus ID / identifier from the request body, or null if unparseable. */
async function loginIdentity(c: Context<AppEnv>): Promise<string | null> {
  try {
    // Hono caches the parsed body on the request, so the handler's own
    // c.req.json() below does not re-read the stream.
    const parsed = loginSchema.safeParse(await c.req.json());
    if (!parsed.success) return null;
    return normalizeIdentifier(parsed.data.identifier);
  } catch {
    // Malformed/absent JSON — let the handler's parse produce the 400.
    return null;
  }
}

function normalizeIdentifier(identifier: string): string {
  return `id:${identifier.trim().toLowerCase()}`;
}

export const authRouter = new Hono<AppEnv>();

authRouter.post("/login", loginLimiter, async (c) => {
  const { identifier, password, school } = loginSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const { JWT_SECRET } = getBindings(c);
  const result = await login(pool, JWT_SECRET, identifier, password, school);

  // Credentials checked out, so this identifier is not under a guessing run
  // from this user's perspective: clear the counter so a student who mistyped
  // a few times isn't still paying delay on their next login.
  await resetRateLimit(c, LOGIN_LIMIT_PREFIX, normalizeIdentifier(identifier));

  return c.json(result);
});

/**
 * Who am I, according to the server right now.
 *
 * Answers from the row requireAuth() already read for this request, so it adds
 * no query. Tolerant of a pending password change on purpose: the client needs
 * to be able to ask "why was I blocked?" while it is blocked.
 */
authRouter.get("/me", requireAuthAllowPasswordChange(), (c) => {
  const session = c.get("sessionUser")!;
  return c.json({
    id: session.id,
    role: session.role,
    name: session.name,
    email: session.email,
    rollNumber: session.rollNumber,
    kitchen: session.kitchen,
    mustChangePassword: session.mustChangePassword,
    isActive: session.isActive,
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  // Length/complexity is enforced by assertPasswordStrength so that every
  // rejection comes back as one WEAK_PASSWORD code with a message the UI can
  // show, rather than half as a Zod issue array and half as an ApiError.
  newPassword: z.string().min(1).max(512),
});

/**
 * Set your own password. This is the ONLY way a user flagged
 * mustChangePassword can clear the flag themselves, and the only endpoint
 * besides /me and /logout-everywhere that will serve them at all.
 *
 * Side effects, all deliberate: the flag clears, every token issued before now
 * dies, and a replacement token comes back in the response so the caller is
 * not logged out by their own success.
 */
authRouter.post(
  "/change-password",
  requireAuthAllowPasswordChange(),
  changePasswordLimiter,
  async (c) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(await c.req.json());
    const pool = getRequestPool(c);
    const { JWT_SECRET } = getBindings(c);
    const user = c.get("user")!;

    const result = await changeOwnPassword(pool, JWT_SECRET, user.id, currentPassword, newPassword);
    await resetRateLimit(c, CHANGE_PASSWORD_LIMIT_PREFIX, `u:${user.id}`);
    await logAction(pool, user.id, "PASSWORD_CHANGED", "User", user.id, {
      clearedForcedChange: user.mustChangePassword,
    });

    return c.json(result);
  }
);

/**
 * Sign out every device, including this one. Nothing is returned to log back
 * in with — that is the point. Reachable with a pending password change so a
 * student who suspects a classmate is using their account can cut the sessions
 * first and sort the password out after.
 */
authRouter.post("/logout-everywhere", requireAuthAllowPasswordChange(), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const result = await logoutEverywhere(pool, user.id);
  await logAction(pool, user.id, "LOGOUT_EVERYWHERE", "User", user.id);
  return c.json(result);
});

const adminResetSchema = z
  .object({
    userId: z.string().uuid().optional(),
    rollNumber: z.string().min(1).optional(),
    email: z.string().email().optional(),
    temporaryPassword: z.string().min(1).max(512).optional(),
  })
  .refine((v) => Boolean(v.userId || v.rollNumber || v.email), {
    message: "Provide one of userId, rollNumber or email.",
  });

/**
 * Admin-mediated password reset — the replacement for an emailed reset link,
 * which cannot work here: student addresses are synthesised from roll numbers
 * and no mail is deliverable to them.
 *
 * ADMIN is the floor; SUPERADMIN passes the same gate. Which accounts each may
 * actually reset is decided in the service (assertMayReset) — a kitchen admin
 * resetting another admin would be a one-step privilege escalation.
 *
 * The temporary password is in the response body once and is not recoverable.
 */
authRouter.post("/admin/reset-password", requireAuth("ADMIN"), changePasswordLimiter, async (c) => {
  const input = adminResetSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;

  const result = await adminResetPassword(pool, { id: actor.id, role: actor.role }, input);
  await logAction(pool, actor.id, "PASSWORD_RESET_BY_ADMIN", "User", result.userId, {
    rollNumber: result.rollNumber,
    // The password itself is never written to the audit log.
    generated: input.temporaryPassword === undefined,
  });

  return c.json(result);
});

/**
 * The password rules, so the client can state them up front instead of
 * discovering them one 400 at a time. Public: they are constraints, not data.
 */
authRouter.get("/password-policy", (c) =>
  c.json({
    minLength: MIN_PASSWORD_LENGTH,
    maxBytes: MAX_PASSWORD_BYTES,
    requiresLetter: true,
    requiresNumber: true,
    forbidsCommonPasswords: true,
    forbidsIdentifiers: ["rollNumber", "email", "name"],
  })
);
