import type { Pool, PoolClient } from "@neondatabase/serverless";

export interface TxOptions {
  /** Max time to wait to acquire a row lock inside this transaction, ms. */
  lockTimeoutMs?: number;
  /** Max wall-clock time for the whole transaction, ms. */
  statementTimeoutMs?: number;
}

/**
 * Real BEGIN/COMMIT/ROLLBACK on one checked-out connection. Replaces
 * prisma.$transaction(fn, { maxWait, timeout }).
 *
 * Prisma's `maxWait` (time waiting for a free connection/transaction slot)
 * has no per-call equivalent against a single Pool.connect() and is left to
 * the pool's own connection-acquisition behavior. What actually matters for
 * updateOrderStatus's `FOR UPDATE` contention is capped explicitly instead:
 * how long we wait on the row lock (lockTimeoutMs, Postgres `lock_timeout`
 * — raises 55P03 lock_not_available) and how long the whole transaction may
 * run (statementTimeoutMs, Postgres `statement_timeout` — raises 57014
 * query_canceled). Both map to the same retryable 409 in errorHandler.ts
 * that Prisma's P2028 used to (see src/db/errors.ts's isRetryableLockError).
 *
 * SET LOCAL scopes both timeouts to this transaction only; they reset at
 * COMMIT/ROLLBACK, so they never leak onto a pooled connection's next use.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const { lockTimeoutMs = 10_000, statementTimeoutMs = 15_000 } = options;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
