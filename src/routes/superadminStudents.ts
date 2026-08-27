import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { importStudentRoster, DEFAULT_STUDENT_PASSWORD } from "../services/studentRosterService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool, getBindings } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const superAdminStudentsRouter = new Hono<AppEnv>();

superAdminStudentsRouter.use("*", requireAuth("SUPERADMIN"));

const rosterSchema = z.object({ csv: z.string().min(1).max(1_000_000) });

superAdminStudentsRouter.post("/bulk", async (c) => {
  const { csv } = rosterSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const { DEFAULT_STUDENT_PASSWORD: bound } = getBindings(c) as { DEFAULT_STUDENT_PASSWORD?: string };

  const summary = await importStudentRoster(pool, csv, bound || DEFAULT_STUDENT_PASSWORD);
  await logAction(pool, actor.id, "STUDENT_ROSTER_IMPORT", "User", undefined, {
    created: summary.created,
    skipped: summary.skipped,
  });
  return c.json(summary);
});
