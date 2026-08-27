import type { Pool } from "@neondatabase/serverless";
import type { Role } from "./db/schema.js";
import type { SessionUser } from "./services/authService.js";
import type { TokenPayload } from "./lib/jwt.js";

/**
 * Cloudflare Workers bindings + secrets, injected per-request via c.env.
 * Configured in wrangler.jsonc (vars, kv_namespaces, durable_objects) and via
 * `wrangler secret put <NAME>` for the sensitive entries.
 *
 * Locally (vitest via @hono/node-server) these are resolved from
 * process.env instead, via hono/adapter's env() helper — see
 * src/lib/context.ts's getBindings().
 */
export interface Bindings {
  [key: string]: unknown;
  DATABASE_URL: string;
  JWT_SECRET: string;
  QR_TOKEN_SECRET: string;
  CORS_ORIGIN: string;
  RATE_LIMIT_KV: KVNamespace;
  ORDER_EVENTS_HUB: DurableObjectNamespace;
  RATE_LIMITER_HUB: DurableObjectNamespace;
  /**
   * Kill switch for the forced-password-change gate: "false" (case-insensitive)
   * reports the flag but stops requireAuth() refusing flagged users. Anything
   * else, including absent, means enforced.
   *
   * It exists because the offline load-testing harness mints its own tokens for
   * the bulk-created student cohort and places orders with them; if that cohort
   * ever gets flagged, this is the one-line way to unblock the harness without
   * editing auth code or writing to the live database.
   */
  ENFORCE_PASSWORD_CHANGE?: string;
  /** Bot token from @BotFather. Set via wrangler secret / .env — never commit. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Public @username without @. Optional if getMe can resolve it. */
  TELEGRAM_BOT_USERNAME?: string;
  /** Optional secret for X-Telegram-Bot-Api-Secret-Token on the webhook. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export interface AuthUser {
  id: string;
  role: Role;
  kitchen?: string | null;
  /**
   * Mirrors User.mustChangePassword as of THIS request, read from the database
   * rather than from the token — a flag baked into a 12-hour JWT would keep
   * claiming the student still owed a password change long after they made it.
   */
  mustChangePassword: boolean;
}

export interface Variables {
  user?: AuthUser;
  /** Per-request connection pool — see getRequestPool() in lib/context.ts. */
  pool?: Pool;
  /**
   * The account row requireAuth() read for this request, memoized so that a
   * route carrying both a router-level and a route-level requireAuth() costs
   * one lookup rather than two. Also reused by GET /auth/me.
   */
  sessionUser?: SessionUser;
  /**
   * Signature/expiry-verified JWT payload for this request, memoized so the
   * global rate limiter (middleware/rateLimit.ts, which needs the caller's
   * identity before requireAuth() has run) and requireAuth() itself don't
   * each verify the same token independently. Same token, same secret, same
   * request — the second verification was always going to produce an
   * identical result, just paid for twice.
   */
  verifiedJwtPayload?: TokenPayload;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
