import { Pool, neon, types } from "@neondatabase/serverless";
import type { QueryRunner } from "../db/sql.js";

/**
 * Every `DateTime` column in this schema is Postgres `timestamp` (no time
 * zone) — the driver's default parser reconstructs those as a JS Date using
 * the HOST'S LOCAL time zone, not UTC, since the wire text carries no offset.
 * On a host whose local time isn't UTC (any non-UTC dev machine or CI
 * runner — Cloudflare Workers itself is always UTC, so production is
 * unaffected) that silently shifts every timestamp read back from the
 * database by the host's UTC offset. Registering a UTC-explicit parser here
 * makes reads consistent regardless of host time zone. (Outbound: values are
 * written via `date.toISOString()` at raw-SQL call sites, which is always
 * UTC, so only the read direction needed fixing.)
 */
types.setTypeParser(types.builtins.TIMESTAMP, (value: string) => new Date(`${value.replace(" ", "T")}Z`));

/**
 * Workers tears down every I/O object a request created once that request
 * ends, sockets included. A Pool memoized in module scope therefore hangs
 * the *next* request that reuses it — workerd kills it with "your Worker's
 * code had hung and would never generate a response", which reaches the
 * browser as a header-less 500 (i.e. a phantom CORS failure). So on Workers
 * each call builds a fresh pool, memoized per-request in getRequestPool()
 * rather than globally.
 *
 * Under Node (vitest, seed scripts) there is no such teardown and a pool per
 * call would leak connections, so that runtime keeps the original memoization.
 *
 * This is the same lifecycle src/lib/prisma.ts used, ported unchanged — only
 * the client type changed (Pool instead of a Prisma-adapter-wrapped client).
 */
const isWorkers =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let cached: { url: string; pool: Pool } | undefined;

export function createPool(databaseUrl: string): Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  return new Pool({ connectionString: databaseUrl });
}

export function getPool(databaseUrl: string): Pool {
  if (isWorkers) return createPool(databaseUrl);
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (cached && cached.url === databaseUrl) return cached.pool;

  const pool = createPool(databaseUrl);
  cached = { url: databaseUrl, pool };
  return pool;
}

/**
 * HTTP-transport client for single, non-transactional statements — Neon's
 * documented shape for this workload on edge/serverless runtimes. Unlike
 * `Pool`, this has no socket to tear down between requests (it rides `fetch`,
 * which benefits from Cloudflare's edge-to-origin keep-alive), so it is safe
 * to build once and reuse across every request on every runtime, Workers
 * included — no per-request handshake, unlike `getPool()` above.
 *
 * `fullResults: true` shapes its `.query()` return as `{ rows, rowCount, ... }`,
 * matching `Pool.query()`'s convention. Returned as a plain `QueryRunner`-
 * shaped wrapper (not the raw driver function) — TypeScript's structural
 * check on a generic method rejects the driver's own `.query()` signature
 * directly, and callers here never need the driver's other surface (the
 * tagged-template form, `.transaction()`, etc.) anyway.
 *
 * Reserved for read-only call sites. Anything that needs a transaction (row
 * locks, multi-statement atomicity — see orderService.ts's `withTransaction`
 * users) must keep using `Pool`; the HTTP driver's `.transaction()` runs
 * queries as a non-interactive batch, not the same guarantee.
 *
 * Not used for every read yet — see the type-parser note above: this codebase
 * registers a custom TIMESTAMP parser on `Pool`'s type registry
 * (`types.setTypeParser`), and it is unverified whether `neon()`'s HTTP
 * client shares that same global registry. Confined for now to read paths
 * whose tables carry no `timestamp` column (menu categories/items), where
 * the question can't matter either way.
 */
let cachedHttpSql: { url: string; runner: QueryRunner } | undefined;

export function getHttpSql(databaseUrl: string): QueryRunner {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (cachedHttpSql && cachedHttpSql.url === databaseUrl) return cachedHttpSql.runner;

  const sql = neon(databaseUrl, { fullResults: true });
  const runner: QueryRunner = {
    // The driver's own .query() is generic in the same way Pool.query() is,
    // but returns Record<string, any>[] under the hood — this cast is the
    // same "trust the caller's T" contract QueryRunner already makes at its
    // one other implementation (Pool.query<T>() itself).
    query: (text, values) => sql.query(text, values as any[]) as any,
  };
  cachedHttpSql = { url: databaseUrl, runner };
  return runner;
}
