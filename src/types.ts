import type { Pool } from "@neondatabase/serverless";
import type { Role, School } from "./db/schema.js";
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
  /**
   * OAuth 2.0 Web client IDs for "Sign in with Google", one per school —
   * separate GCP projects/consent screens so either can be rotated or
   * reconfigured without touching the other. Each is checked as the `aud`
   * claim on that school's Google ID tokens, so a DRK-issued token can never
   * be replayed against the KLH flow or vice versa.
   *
   * Public by design — `aud` is carried by every Google ID token and both
   * ids ship inside the frontend bundle, so they live in `vars`, not as
   * `wrangler secret`s. There is no matching client secret binding: the
   * ID-token flow this app uses never does a server-side code exchange.
   */
  GOOGLE_CLIENT_ID_DRK?: string;
  GOOGLE_CLIENT_ID_KLH?: string;
  /** Separate OAuth client for the walk-up guest sign-in. Distinct from the
   *  student clients on purpose: verification checks the ID token's `aud`
   *  against this value, so a student token cannot be replayed as a guest
   *  session or vice versa. See services/googleGuestService.ts. */
  GOOGLE_CLIENT_ID_GUEST?: string;
  /**
   * Master switch for UPI payments. "true" (case-insensitive) turns checkout
   * on; anything else, including absent, leaves ordering exactly as it was
   * before payments existed.
   *
   * Off is the safe default on purpose. Flipping it on with the secrets
   * missing does NOT half-enable the feature — services/paymentService.ts's
   * paymentsEnabled() requires both the flag and the credentials, so a
   * misconfigured deploy presents no checkout rather than one that cannot
   * settle.
   */
  PAYMENTS_ENABLED?: string;
  /**
   * SafeUPI API key, sent as `secret` in every request body.
   *
   * SafeUPI offers no header form, so this credential necessarily travels in
   * the body — which is why nothing in paymentService.ts ever logs a request
   * body, only responses.
   *
   * Secret — `wrangler secret put SAFEUPI_API_SECRET`.
   */
  SAFEUPI_API_SECRET?: string;
  /**
   * The value SafeUPI echoes back inside a webhook body.
   *
   * NOT a signing key: SafeUPI does not sign its webhooks, so this proves only
   * that the sender knows the secret and nothing about the payload's
   * integrity. It is therefore necessary but not sufficient — every settlement
   * is independently confirmed against SafeUPI's Status API before food is
   * released. Treat it like a password all the same: anything that ever logs a
   * webhook body leaks it.
   *
   * Secret — `wrangler secret put SAFEUPI_WEBHOOK_SECRET`.
   */
  SAFEUPI_WEBHOOK_SECRET?: string;
  /**
   * Where SafeUPI returns the student's browser after the hosted payment page.
   * A public frontend URL, so it lives in vars rather than as a secret.
   *
   * The payment id is appended as a query parameter at create time, so this
   * should be the bare landing route.
   */
  SAFEUPI_REDIRECT_URL?: string;
  /**
   * Optional connected-merchant id to route payments to. Omitted, SafeUPI uses
   * the business default and falls back to other eligible merchants.
   */
  SAFEUPI_MERCHANT_ID?: string;
}

export interface AuthUser {
  id: string;
  role: Role;
  kitchen?: string | null;
  school: School;
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
