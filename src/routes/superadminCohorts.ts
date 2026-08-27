import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  listCohorts,
  previewCohortDeactivation,
  promoteCohort,
  MIN_COHORT_PREFIX_LENGTH,
} from "../services/cohortService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";

/**
 * Year-end cohort promotion, mounted at /superadmin/cohorts.
 *
 * The flow is deliberately three calls, not one:
 *
 *   GET  /superadmin/cohorts              -> which intakes exist, and how big
 *   POST /superadmin/cohorts/preview      -> what a promotion WOULD change
 *   POST /superadmin/cohorts/promote      -> do it, echoing back the count you
 *                                            were just shown
 *
 * `promote` dry-runs by default and refuses to write unless the body carries
 * both `confirm` (the prefix again) and `expectedCount` (the number `preview`
 * reported). Deactivating 150 real accounts is not reversible by an undo
 * button — it is reversible only by knowing exactly which accounts moved,
 * which is why the audit entry records every id.
 */
export const superAdminCohortsRouter = new Hono<AppEnv>();

superAdminCohortsRouter.use("*", requireAuth("SUPERADMIN"));

const prefixSchema = z.string().trim().min(MIN_COHORT_PREFIX_LENGTH).max(20);

const previewSchema = z.object({ prefix: prefixSchema });

const promoteSchema = z.object({
  prefix: prefixSchema,
  /** Defaults to a dry run: a body that forgets the flag changes nothing. */
  dryRun: z.boolean().optional().default(true),
  confirm: z.string().optional(),
  expectedCount: z.number().int().min(0).optional(),
});

superAdminCohortsRouter.get("/", async (c) => {
  const pool = getRequestPool(c);
  return c.json(await listCohorts(pool));
});

superAdminCohortsRouter.post("/preview", async (c) => {
  const { prefix } = previewSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  return c.json(await previewCohortDeactivation(pool, prefix));
});

// GET alias so a preview can be pulled straight from a browser or a link.
superAdminCohortsRouter.get("/:prefix/preview", async (c) => {
  const prefix = prefixSchema.parse(c.req.param("prefix"));
  const pool = getRequestPool(c);
  return c.json(await previewCohortDeactivation(pool, prefix));
});

superAdminCohortsRouter.post("/promote", async (c) => {
  const body = promoteSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;

  const result = await promoteCohort(pool, {
    prefix: body.prefix,
    actorId: actor.id,
    dryRun: body.dryRun,
    confirm: body.confirm,
    expectedCount: body.expectedCount,
  });

  // A dry run writes nothing, so it gets no audit entry — logging every
  // preview would bury the entries that record an actual change.
  if (result.applied) {
    await logAction(pool, actor.id, "COHORT_DEACTIVATE", "User", undefined, {
      prefix: result.prefix,
      matched: result.matched,
      changed: result.changed,
      alreadyInactive: result.alreadyInactive,
      protectedSkipped: result.protectedSkipped.map((p) => p.email),
      rollNumberRange: result.rollNumberRange,
      tokensValidFrom: result.tokensValidFrom,
      userIds: result.changedUsers.map((u) => u.id),
    });
  }

  return c.json(result);
});
