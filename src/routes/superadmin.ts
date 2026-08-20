import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getStorageStats, clearStorage } from "../services/systemService.js";
import { logAction, getAuditLog } from "../services/auditService.js";
import { getRequestPrisma } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const superAdminRouter = new Hono<AppEnv>();

superAdminRouter.use("*", requireAuth("SUPERADMIN"));

superAdminRouter.get("/storage", async (c) => {
  const prisma = getRequestPrisma(c);
  const stats = await getStorageStats(prisma);
  return c.json(stats);
});

const clearStorageSchema = z.object({
  target: z.string(),
  retainDays: z.number().int().min(0).optional().default(0),
});

superAdminRouter.post("/storage/clear", async (c) => {
  const data = clearStorageSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const result = await clearStorage(prisma, data.target, data.retainDays);
  await logAction(prisma, user.id, "STORAGE_CLEAR", data.target, undefined, {
    retainDays: data.retainDays,
    deletedCount: result.deletedCount,
  });
  return c.json(result);
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  before: z.string().datetime().optional(),
});

superAdminRouter.get("/audit-log", async (c) => {
  const { limit, before } = auditLogQuerySchema.parse({
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });
  const prisma = getRequestPrisma(c);
  const entries = await getAuditLog(prisma, limit, before);
  return c.json(entries);
});
