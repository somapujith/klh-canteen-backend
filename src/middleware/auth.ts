import type { MiddlewareHandler } from "hono";
import { env } from "hono/adapter";
import type { Role } from "@prisma/client";
import { verifyToken } from "../lib/jwt.js";
import { ApiError } from "./errorHandler.js";
import type { AppEnv } from "../types.js";

export function requireAuth(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let token = "";
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else {
      const queryToken = c.req.query("token");
      if (queryToken) token = queryToken;
    }

    if (!token) {
      throw new ApiError(401, "NO_TOKEN", "Missing authorization token");
    }
    try {
      const { JWT_SECRET } = env<{ JWT_SECRET: string }>(c);
      const payload = verifyToken(token, JWT_SECRET);
      if (roles.length > 0 && !roles.includes(payload.role) && payload.role !== "SUPERADMIN") {
        throw new ApiError(403, "FORBIDDEN", "Insufficient role");
      }
      c.set("user", { id: payload.sub, role: payload.role, kitchen: payload.kitchen });
      await next();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token");
    }
  };
}
