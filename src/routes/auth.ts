import { Hono } from "hono";
import { z } from "zod";
import { login } from "../services/authService.js";
import { getBindings, getRequestPrisma } from "../lib/context.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { AppEnv } from "../types.js";

const loginLimiter = rateLimit({
  prefix: "login",
  windowSeconds: 15 * 60,
  max: 10,
  code: "TOO_MANY_LOGIN_ATTEMPTS",
  message: "Too many login attempts, please try again later.",
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export const authRouter = new Hono<AppEnv>();

authRouter.post("/login", loginLimiter, async (c) => {
  const { identifier, password } = loginSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const { JWT_SECRET } = getBindings(c);
  const result = await login(prisma, JWT_SECRET, identifier, password);
  return c.json(result);
});
