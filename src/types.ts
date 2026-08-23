import type { PrismaClient, Role } from "@prisma/client";

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
}

export interface AuthUser {
  id: string;
  role: Role;
  kitchen?: string | null;
}

export interface Variables {
  user?: AuthUser;
  /** Per-request PrismaClient — see getRequestPrisma() in lib/context.ts. */
  prisma?: PrismaClient;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
