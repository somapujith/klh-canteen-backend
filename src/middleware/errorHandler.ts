import type { ErrorRequestHandler } from "express";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { message: err.message, code: err.code } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { message: "Internal server error", code: "INTERNAL" } });
};
