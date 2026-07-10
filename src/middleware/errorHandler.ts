import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";

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
// see deliverOrder's FOR UPDATE locking). This is expected backpressure
// under load, not a server bug, so surface it as a retryable 409 instead of
// leaking a raw 500 with internal error details to the client.
function isRetryableTransactionError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028";
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { message: err.message, code: err.code } });
    return;
  }
  if (isRetryableTransactionError(err)) {
    res.status(409).json({
      error: { message: "Request could not be completed due to a conflicting operation; please retry", code: "CONFLICT_RETRY" },
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { message: "Internal server error", code: "INTERNAL" } });
};
