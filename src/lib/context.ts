import type { Context } from "hono";
import { env } from "hono/adapter";
import { getPrisma } from "./prisma.js";
import type { AppEnv, Bindings } from "../types.js";

/**
 * Resolves the current request's bindings/secrets uniformly across runtimes:
 * on Cloudflare Workers these come from c.env (wrangler.jsonc vars +
 * `wrangler secret put`); on local Node (vitest via @hono/node-server) the
 * same call reads process.env instead — see hono/adapter's env() helper.
 * KV/Durable Object bindings simply resolve to undefined under Node, which
 * the rate limiter and sseService both treat as a graceful no-op.
 */
export function getBindings(c: Context<AppEnv>): Bindings {
  return env<Bindings>(c);
}

/** Lazily-memoized PrismaClient for the current request's DATABASE_URL. */
export function getRequestPrisma(c: Context<AppEnv>) {
  return getPrisma(getBindings(c).DATABASE_URL);
}
