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

/**
 * PrismaClient for the current request's DATABASE_URL, memoized on the request
 * context so repeated calls within one request share a client. The memo has to
 * live here rather than in module scope because Workers invalidates a previous
 * request's sockets — see the note in lib/prisma.ts.
 */
export function getRequestPrisma(c: Context<AppEnv>) {
  const existing = c.get("prisma");
  if (existing) return existing;

  const client = getPrisma(getBindings(c).DATABASE_URL);
  c.set("prisma", client);
  return client;
}
