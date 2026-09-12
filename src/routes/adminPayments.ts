import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAdminPaymentStats, getAdminPaymentsList } from "../services/adminPaymentService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminPaymentsRouter = new Hono<AppEnv>();

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  isToday: z.coerce.boolean().default(false),
});

adminPaymentsRouter.get("/stats", requireAuth("ADMIN"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const stats = await getAdminPaymentStats(pool, user.school);
  return c.json(stats);
});

adminPaymentsRouter.get("/", requireAuth("ADMIN"), async (c) => {
  const query = listQuerySchema.parse({
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
    isToday: c.req.query("isToday"),
  });

  const pool = getRequestPool(c);
  const user = c.get("user")!;

  const page = await getAdminPaymentsList(
    pool,
    user.school,
    query.cursor,
    query.limit,
    query.isToday
  );

  return c.json(page);
});
