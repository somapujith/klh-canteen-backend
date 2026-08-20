import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { importStudentsFromCsv } from "../services/studentImportService.js";
import { getRequestPrisma } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminStudentsRouter = new Hono<AppEnv>();

const bulkSchema = z.object({ csv: z.string().min(1).max(500_000) });

adminStudentsRouter.post("/bulk", requireAuth("ADMIN"), async (c) => {
  const { csv } = bulkSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const results = await importStudentsFromCsv(prisma, csv);
  return c.json({ results });
});
