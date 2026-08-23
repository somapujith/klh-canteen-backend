import type { PrismaClient, Role } from "@prisma/client";
import type { SessionUser } from "./services/authService.js";

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
  /** Per-request PrismaClient — see getRequestPrisma() in lib/context.ts. */
  prisma?: PrismaClient;
  /**
   * The account row requireAuth() read for this request, memoized so that a
   * route carrying both a router-level and a route-level requireAuth() costs
   * one lookup rather than two. Also reused by GET /auth/me.
   */
  sessionUser?: SessionUser;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
