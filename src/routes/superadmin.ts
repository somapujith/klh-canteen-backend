import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getStorageStats, clearStorage } from "../services/systemService.js";
import { logAction, getAuditLog } from "../services/auditService.js";

export const superAdminRouter = Router();

superAdminRouter.use(requireAuth("SUPERADMIN"));

superAdminRouter.get("/storage", async (req, res, next) => {
  try {
    const stats = await getStorageStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

const clearStorageSchema = z.object({
  target: z.string(),
  retainDays: z.number().int().min(0).optional().default(0),
});

superAdminRouter.post("/storage/clear", async (req, res, next) => {
  try {
    const data = clearStorageSchema.parse(req.body);
    const result = await clearStorage(data.target, data.retainDays);
    await logAction(req.user!.id, "STORAGE_CLEAR", data.target, undefined, {
      retainDays: data.retainDays,
      deletedCount: result.deletedCount,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  before: z.string().datetime().optional(),
});

superAdminRouter.get("/audit-log", async (req, res, next) => {
  try {
    const { limit, before } = auditLogQuerySchema.parse(req.query);
    const entries = await getAuditLog(limit, before);
    res.json(entries);
  } catch (err) {
    next(err);
  }
});
