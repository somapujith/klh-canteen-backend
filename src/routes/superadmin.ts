import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getStorageStats, clearStorage } from "../services/systemService.js";

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
    res.json(result);
  } catch (err) {
    next(err);
  }
});
