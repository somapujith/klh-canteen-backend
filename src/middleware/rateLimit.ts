import type { MiddlewareHandler } from "hono";
import { env } from "hono/adapter";
import { ApiError } from "./errorHandler.js";
import type { AppEnv } from "../types.js";

interface RateLimitOptions {
  /** KV key prefix, e.g. "global" or "orders" */
  prefix: string;
  /** Fixed window size in seconds */
  windowSeconds: number;
  /** Max requests allowed per window per key */
  max: number;
  /** How to derive the per-caller key (defaults to client IP) */
  keyFn?: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
  /** Error message/code when the limit is exceeded */
  message: string;
  code: string;
}

// Fixed-window counter backed by Cloudflare KV. Workers has no shared
// in-process memory across isolates/instances, so per-IP/per-user request
// counters live in KV instead of an in-memory Map (what express-rate-limit
// used). KV writes are eventually consistent, so this is an approximate
// limiter (fine for abuse protection, not a hard billing-grade guarantee).
//
// If RATE_LIMIT_KV isn't bound (e.g. local Node test runs via
// @hono/node-server, where no Workers bindings exist), the limiter no-ops
// rather than throwing, so local/test behavior is unaffected.
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { RATE_LIMIT_KV } = env<{ RATE_LIMIT_KV?: KVNamespace }>(c);
    if (!RATE_LIMIT_KV) {
      await next();
      return;
    }

    const identity = options.keyFn ? options.keyFn(c) : defaultClientKey(c);
    const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
    const key = `${options.prefix}:${identity}:${window}`;

    const current = Number((await RATE_LIMIT_KV.get(key)) ?? "0");
    if (current >= options.max) {
      throw new ApiError(429, options.code, options.message);
    }

    await RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: options.windowSeconds + 5 });
    await next();
  };
}

function defaultClientKey(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
