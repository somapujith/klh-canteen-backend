import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { importStudentsFromCsv } from "../services/studentImportService.js";

export const adminStudentsRouter = Router();

const bulkSchema = z.object({ csv: z.string().min(1) });

adminStudentsRouter.post("/bulk", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const { csv } = bulkSchema.parse(req.body);
    const results = await importStudentsFromCsv(csv);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});
