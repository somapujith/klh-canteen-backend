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
   * VyaparGateway live API key (`vg_live_...`). Authenticates our create_order
   * and check_order_status calls, sent as the X-API-Key header so it never
   * rides in a request body that might be logged.
   *
   * Secret — `wrangler secret put VYAPAR_API_KEY`. Never in wrangler.jsonc.
   */
  VYAPAR_API_KEY?: string;
  /**
   * Webhook signing secret (`whsec_...`). The HMAC-SHA256 key every inbound
   * webhook signature is checked against; it is what distinguishes a real
   * payment notification from anyone who has guessed the endpoint URL. Without
   * it a POST claiming "payment.success" would release food for free.
   *
   * Secret — `wrangler secret put VYAPAR_WEBHOOK_SECRET`.
   */
  VYAPAR_WEBHOOK_SECRET?: string;
  /**
   * Public HTTPS URL of our own webhook endpoint, sent as `callback_url` on
   * every create_order. Must be reachable from the public internet — the
   * gateway's servers call it, not the browser — so localhost only works
   * behind a tunnel.
   *
   * Per-order and therefore authoritative over whatever is configured in the
   * VyaparGateway dashboard, which lets a staging deploy receive its own
   * webhooks without disturbing production.
   */
  VYAPAR_CALLBACK_URL?: string;
  /** Where the gateway sends the student's browser after payment. Optional —
   *  omitted when unset, and the in-app poll is what actually decides the UI. */
  VYAPAR_REDIRECT_URL?: string;
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
