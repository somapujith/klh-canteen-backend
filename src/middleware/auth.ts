import type { Request, Response, NextFunction } from "express";
import type { Role } from "@prisma/client";
import { verifyToken } from "../lib/jwt.js";
import { ApiError } from "./errorHandler.js";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

export function requireAuth(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return next(new ApiError(401, "NO_TOKEN", "Missing authorization token"));
    }
    try {
      const payload = verifyToken(header.slice(7));
      if (roles.length > 0 && !roles.includes(payload.role)) {
        return next(new ApiError(403, "FORBIDDEN", "Insufficient role"));
      }
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(new ApiError(401, "INVALID_TOKEN", "Invalid or expired token"));
    }
  };
}
