import type { Context } from "hono";
import { env } from "hono/adapter";
import { getPool } from "./db.js";
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
  const base = env<Bindings>(c);
  // hono/adapter's env() is runtime-dispatched: on workerd it IS c.env, but on
  // Node it returns process.env and ignores c.env entirely. process.env holds
  // strings, so a non-string binding — a Durable Object namespace, or the
  // in-process stand-in the Node server installs (services/nodeEventsHub.ts) —
  // can only be delivered through c.env. Overlaying it here is what lets one
  // getBindings() serve both runtimes; without it the Node hub would be
  // constructed and then never found, which is the shape of the bug this
  // fixes.
  const injected = c.env as Partial<Bindings> | undefined;
  return injected && typeof injected === "object" ? { ...base, ...injected } : base;
}

/**
 * Pool for the current request's DATABASE_URL, memoized on the request
 * context so repeated calls within one request share a pool. The memo has to
 * live here rather than in module scope because Workers invalidates a previous
 * request's sockets — see the note in lib/db.ts.
 */
export function getRequestPool(c: Context<AppEnv>) {
  const existing = c.get("pool");
  if (existing) return existing;

  const pool = getPool(getBindings(c).DATABASE_URL);
  c.set("pool", pool);
  return pool;
}
