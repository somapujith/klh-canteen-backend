import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getPlatformFeePercent, setPlatformFeePercent } from "../db/schoolSettingsRepo.js";
import { getSuperAdminStats } from "../services/orderService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";
import type { School } from "../db/schema.js";

export const superAdminSettingsRouter = new Hono<AppEnv>();

superAdminSettingsRouter.use("*", requireAuth("SUPERADMIN"));

const schoolEnum = z.enum(["KLH", "DRK"]);
const schoolParamSchema = z.object({ school: schoolEnum });
const percentBodySchema = z.object({ percent: z.number().min(0).max(100) });

const ALL_SCHOOLS: School[] = ["KLH", "DRK"];

/**
 * Both schools' current fee % plus today's per-school stats breakdown, in one
 * response — the settings page needs both to render the knob and its effect
 * together.
 */
superAdminSettingsRouter.get("/platform-fee", async (c) => {
  const pool = getRequestPool(c);
  const [percents, stats] = await Promise.all([
    Promise.all(ALL_SCHOOLS.map((school) => getPlatformFeePercent(pool, school))),
    getSuperAdminStats(pool),
  ]);

  const fees = ALL_SCHOOLS.map((school, i) => ({ school, platformFeePercent: percents[i] }));
  return c.json({ fees, stats });
});

superAdminSettingsRouter.patch("/platform-fee/:school", async (c) => {
  const { school } = schoolParamSchema.parse({ school: c.req.param("school") });
  const { percent } = percentBodySchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;

  await setPlatformFeePercent(pool, school, percent);
  await logAction(pool, actor.id, "PLATFORM_FEE_UPDATE", "SchoolSettings", school, { school, percent });

  return c.json({ school, platformFeePercent: percent });
});
