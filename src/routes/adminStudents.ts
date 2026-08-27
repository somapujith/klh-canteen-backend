import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { importStudentsFromCsv } from "../services/studentImportService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminStudentsRouter = new Hono<AppEnv>();

/**
 * Student management is SUPERADMIN-only.
 *
 * Guarding at the router rather than per route so that any endpoint added to
 * this file later is covered by default — the same fail-closed idiom
 * routes/superadminStudents.ts uses. A plain ADMIN now gets 403 FORBIDDEN
 * here; SUPERADMIN passes, as it does for every role gate (middleware/auth.ts).
 */
adminStudentsRouter.use("*", requireAuth("SUPERADMIN"));

const bulkSchema = z.object({ csv: z.string().min(1).max(500_000) });

adminStudentsRouter.post("/bulk", async (c) => {
  const { csv } = bulkSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const results = await importStudentsFromCsv(pool, csv);
  return c.json({ results });
});
