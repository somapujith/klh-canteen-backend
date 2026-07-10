import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { login } from "../services/authService.js";

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);
    const result = await login(identifier, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
