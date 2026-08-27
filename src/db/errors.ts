import { ApiError } from "../middleware/errorHandler.js";

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** Postgres 23505 unique_violation — replaces Prisma's P2002. */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === "23505";
}

/** Postgres 23503 foreign_key_violation — replaces Prisma's P2003/P2014. */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === "23503";
}

/**
 * Postgres 55P03 lock_not_available (SET LOCAL lock_timeout exceeded) or
 * 57014 query_canceled (SET LOCAL statement_timeout exceeded) — replaces
 * Prisma's P2028 "Transaction API error", surfaced by errorHandler.ts as a
 * retryable 409 rather than a raw 500.
 */
export function isRetryableLockError(err: unknown): boolean {
  const code = pgCode(err);
  return code === "55P03" || code === "57014";
}

/**
 * Prisma's P2025 (record to update/delete not found) has no Postgres error
 * code — Prisma infers it from zero affected rows. Call this immediately
 * after an UPDATE/DELETE whose absence should 404 rather than silently
 * no-op.
 */
export function assertAffected(rowCount: number, message = "Record not found"): void {
  if (rowCount === 0) throw new ApiError(404, "NOT_FOUND", message);
}
