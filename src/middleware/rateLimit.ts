import type { Context, MiddlewareHandler } from "hono";
import { env } from "hono/adapter";
import { getBindings } from "../lib/context.js";
import { verifyToken } from "../lib/jwt.js";
import { ApiError } from "./errorHandler.js";
import type { AppEnv } from "../types.js";

/**
 * Identity-based rate limiting.
 *
 * There is deliberately NO IP-based keying anywhere in this file, not even as
 * a fallback: campus WiFi NATs the whole student body behind a single public
 * IP, so an IP-keyed limit either throttles hundreds of innocent students at
 * once or has to be set so high it protects nothing. Students also roam
 * between WiFi and mobile data mid-session, which silently moves them to a
 * fresh bucket. Every limit here keys on *who* is calling instead:
 *
 *   - authenticated routes -> the JWT subject (user id)
 *   - login                -> the submitted campus ID / identifier
 *
 * When no identity can be derived (an anonymous request with no token), the
 * limiter no-ops rather than falling back to a network-level key. Edge-level
 * volumetric protection for anonymous traffic belongs in Cloudflare's WAF /
 * rate-limiting rules, not in application code — see RATE_LIMIT_APP_PATCH.md.
 *
 * Counters live in the RateLimiterHub Durable Object (atomic increments), not
 * KV. If RATE_LIMITER_HUB isn't bound (e.g. local Node/vitest runs via
 * @hono/node-server, where no Workers bindings exist), the limiter no-ops
 * rather than throwing, so local/test behaviour is unaffected.
 */

type RateLimitIdentity = string | null | undefined;

export type RateLimitKeyFn = (
  c: Context<AppEnv>
) => RateLimitIdentity | Promise<RateLimitIdentity>;

/**
 * How the limiter reacts once `max` is exceeded.
 *
 *  - "reject":            respond 429. Safe only where the key cannot be
 *                         chosen by an attacker (i.e. an authenticated user
 *                         id, which they'd need a valid token to spoof).
 *  - "progressive-delay": never refuse, just make each further attempt slower.
 *                         Required anywhere the key is attacker-suppliable —
 *                         above all login, which is keyed on campus ID. A
 *                         reject-style lockout there would let anyone disable
 *                         a specific student's account by spamming wrong
 *                         passwords at their roll number.
 */
export type RateLimitStrategy = "reject" | "progressive-delay";

export interface ProgressiveDelayOptions {
  /** Delay applied to the first attempt past `max`. Doubles from there. */
  baseMs?: number;
  /** Ceiling on the delay, so a legitimate user is always served. */
  maxMs?: number;
  /**
   * Attempt count at which a proof-of-humanity challenge should kick in.
   * See `onChallengeRequired` — nothing is enforced without it.
   */
  challengeAfter?: number;
  /**
   * EXTENSION POINT — additional friction beyond the delay tier.
   *
   * No CAPTCHA/turnstile provider is configured, so this is intentionally
   * left unset today and the delay tier is the only friction in play. When a
   * provider is added, wire it here: verify the challenge token off the
   * request and throw an ApiError(401/403) when it is missing or invalid.
   *
   * Whatever is plugged in MUST stay solvable — it may add work, never a
   * permanent refusal, or the campus-ID lockout hole reopens.
   */
  onChallengeRequired?: (c: Context<AppEnv>, attempts: number) => void | Promise<void>;
}

export interface RateLimitOptions {
  /** Counter namespace, e.g. "global", "orders", "login". */
  prefix: string;
  /** Fixed window size in seconds. */
  windowSeconds: number;
  /**
   * Requests allowed per window per identity before the strategy engages.
   * Under "progressive-delay" this is the number of friction-free attempts.
   */
  max: number;
  /**
   * How to derive the caller's identity. Defaults to the authenticated user
   * id (JWT subject). Return null/undefined to skip limiting this request —
   * never return anything network-derived.
   */
  keyFn?: RateLimitKeyFn;
  /** Error message/code used by the "reject" strategy. */
  message: string;
  code: string;
  /** Defaults to "reject". */
  strategy?: RateLimitStrategy;
  /** Tuning for the "progressive-delay" strategy. */
  delay?: ProgressiveDelayOptions;
}

const DEFAULT_DELAY_BASE_MS = 250;
const DEFAULT_DELAY_MAX_MS = 3_000;

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { RATE_LIMITER_HUB } = getBindings(c) as { RATE_LIMITER_HUB?: DurableObjectNamespace };
    if (!RATE_LIMITER_HUB) {
      await next();
      return;
    }

    const identity = await resolveIdentity(c, options.keyFn);
    if (!identity) {
      // Nothing to key on. Skipping is the deliberate choice — the removed
      // IP fallback is what made this limiter both unfair and evadable.
      await next();
      return;
    }

    const result = await consume(RATE_LIMITER_HUB, options, identity);
    if (!result) {
      // Counter unavailable — fail open. A limiter outage must not take the
      // canteen offline during a lunch rush.
      await next();
      return;
    }

    if ((options.strategy ?? "reject") === "progressive-delay") {
      await applyProgressiveDelay(c, options, result.count);
      await next();
      return;
    }

    if (result.count > options.max) {
      throw new ApiError(429, options.code, options.message);
    }
    await next();
  };
}

/**
 * Clears a caller's counter — call after a genuinely successful action so
 * earlier failed attempts stop costing a legitimate user friction.
 * No-ops when the binding is absent (local/test runs).
 */
export async function resetRateLimit(
  c: Context<AppEnv>,
  prefix: string,
  identity: string
): Promise<void> {
  const { RATE_LIMITER_HUB } = getBindings(c) as { RATE_LIMITER_HUB?: DurableObjectNamespace };
  if (!RATE_LIMITER_HUB) return;

  try {
    const stub = counterStub(RATE_LIMITER_HUB, prefix, identity);
    await stub.fetch("https://rate-limiter-hub/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: prefix }),
    });
  } catch (err) {
    // Best effort: failing to clear a counter only costs the user some delay.
    console.error("rateLimit: reset failed", err);
  }
}

/**
 * Escalating friction that always terminates in the request being served.
 *
 * attempts <= max            -> no delay
 * attempts  = max + n        -> min(baseMs * 2^(n-1), maxMs)
 *
 * With the login defaults (max 5, base 250ms, cap 3s) that is
 * 250ms, 500ms, 1s, 2s, then 3s forever. Costly enough to flatten an online
 * password-guessing run, while a student who mistypes their password five
 * times still gets in on the sixth try — just a little slower.
 */
async function applyProgressiveDelay(
  c: Context<AppEnv>,
  options: RateLimitOptions,
  attempts: number
): Promise<void> {
  if (attempts <= options.max) return;

  const baseMs = options.delay?.baseMs ?? DEFAULT_DELAY_BASE_MS;
  const maxMs = options.delay?.maxMs ?? DEFAULT_DELAY_MAX_MS;
  const overage = attempts - options.max;
  const delayMs = Math.min(baseMs * 2 ** (overage - 1), maxMs);

  await sleep(delayMs);

  // EXTENSION POINT: a challenge (CAPTCHA / Turnstile) would plug in here,
  // as the tier above pure delay. Unconfigured today, so this is inert.
  const challengeAfter = options.delay?.challengeAfter;
  if (challengeAfter !== undefined && attempts > challengeAfter) {
    await options.delay?.onChallengeRequired?.(c, attempts);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consume(
  namespace: DurableObjectNamespace,
  options: RateLimitOptions,
  identity: string
): Promise<{ count: number; resetAt: number } | null> {
  try {
    const stub = counterStub(namespace, options.prefix, identity);
    const res = await stub.fetch("https://rate-limiter-hub/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: options.prefix, windowSeconds: options.windowSeconds }),
    });
    if (!res.ok) return null;
    return await res.json<{ count: number; resetAt: number }>();
  } catch (err) {
    console.error("rateLimit: counter unavailable, failing open", err);
    return null;
  }
}

/**
 * One Durable Object instance per (prefix, identity). Sharding this finely
 * keeps the atomic counter off any shared hot path — a single global instance
 * would serialise every request in the app through one process.
 */
function counterStub(
  namespace: DurableObjectNamespace,
  prefix: string,
  identity: string
): DurableObjectStub {
  return namespace.get(namespace.idFromName(`${prefix}:${identity}`));
}

async function resolveIdentity(
  c: Context<AppEnv>,
  keyFn?: RateLimitKeyFn
): Promise<string | null> {
  const identity = keyFn ? await keyFn(c) : authenticatedIdentity(c);
  return identity ? identity : null;
}

/**
 * The JWT subject of the caller, or null for anonymous requests.
 *
 * requireAuth() puts the verified payload on the context, but the global
 * limiter runs before it, so the token is verified here as well when the
 * context is empty. Verification (rather than a bare decode) matters: an
 * unverified `sub` is attacker-chosen, which would let one caller spread
 * their traffic across unlimited buckets.
 */
function authenticatedIdentity(c: Context<AppEnv>): string | null {
  const user = c.get("user");
  if (user?.id) return `u:${user.id}`;

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (c.req.query("token") ?? "");
  if (!token) return null;

  try {
    const { JWT_SECRET } = env<{ JWT_SECRET?: string }>(c);
    if (!JWT_SECRET) return null;
    return `u:${verifyToken(token, JWT_SECRET).sub}`;
  } catch {
    return null;
  }
}
