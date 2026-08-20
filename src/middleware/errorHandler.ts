import type { ErrorHandler } from "hono";
import { Prisma } from "@prisma/client";
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

// Prisma P2028 = "Transaction API error" (e.g. the transaction timed out,
// commonly while waiting on a row lock under heavy concurrent contention —
// see updateOrderStatus's FOR UPDATE locking). This is expected backpressure
// under load, not a server bug, so surface it as a retryable 409 instead of
// leaking a raw 500 with internal error details to the client.
function isRetryableTransactionError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028";
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
  console.error(err);
  return c.json({ error: { message: "Internal server error", code: "INTERNAL" } }, 500);
};
