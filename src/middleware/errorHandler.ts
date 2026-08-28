import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "../types.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

// Postgres 55P03 lock_not_available / 57014 query_canceled — raised by the
// SET LOCAL lock_timeout / statement_timeout guards in src/db/tx.ts's
// withTransaction (e.g. updateOrderStatus's FOR UPDATE locking timing out
// under heavy concurrent contention). This is expected backpressure under
// load, not a server bug, so surface it as a retryable 409 instead of
// leaking a raw 500 with internal error details to the client.
function isRetryableTransactionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "55P03" || code === "57014";
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { message: err.message, code: err.code } }, err.status as any);
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { message: "Validation error", code: "VALIDATION_ERROR", details: err.issues } },
      400
    );
  }
  if (isRetryableTransactionError(err)) {
    return c.json(
      {
        error: {
          message: "Request could not be completed due to a conflicting operation; please retry",
          code: "CONFLICT_RETRY",
        },
      },
      409
    );
  }
  // Postgres 23503 foreign_key_violation — a row still referenced by another
  // table under ON DELETE RESTRICT. Menu items no longer reach here (deleting
  // one archives it instead; see MenuItem.isArchived), but the other RESTRICT
  // FKs — Category's, Order's — can still refuse a delete, and a bare 500 tells
  // the admin nothing. Duplicated from src/db/errors.ts's isForeignKeyViolation
  // rather than imported: that module imports ApiError from this one.
  if ((err as { code?: string } | null)?.code === "23503") {
    return c.json(
      {
        error: {
          message: "This cannot be deleted while other records still reference it",
          code: "IN_USE",
        },
      },
      409
    );
  }
  console.error(err);
  return c.json({ error: { message: "Internal server error", code: "INTERNAL" } }, 500);
};
