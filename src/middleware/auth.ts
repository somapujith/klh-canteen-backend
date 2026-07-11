import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";
import { verifyToken } from "../lib/jwt.js";
import { ApiError } from "./errorHandler.js";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role; kitchen?: string | null };
    }
  }
}

export function requireAuth(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    let token = "";
    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.slice(7);
    } else if (req.query.token && typeof req.query.token === "string") {
      token = req.query.token;
    }

    if (!token) {
      return next(new ApiError(401, "NO_TOKEN", "Missing authorization token"));
    }
    try {
      const payload = verifyToken(token);
      if (roles.length > 0 && !roles.includes(payload.role) && payload.role !== "SUPERADMIN") {
        return next(new ApiError(403, "FORBIDDEN", "Insufficient role"));
      }
      req.user = { id: payload.sub, role: payload.role, kitchen: payload.kitchen };
      next();
    } catch {
      next(new ApiError(401, "INVALID_TOKEN", "Invalid or expired token"));
    }
  };
}
