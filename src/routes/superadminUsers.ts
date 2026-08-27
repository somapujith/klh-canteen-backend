import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { usernameForRollNumber } from "../services/studentRosterService.js";
import {
  listUsers,
  countUsers,
  createUser,
  updateUser,
  deleteUser,
  setUsersActive,
  DEFAULT_USER_PAGE_SIZE,
  MAX_USER_PAGE_SIZE,
  MAX_BULK_USER_IDS,
} from "../services/userAdminService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const superAdminUsersRouter = new Hono<AppEnv>();

superAdminUsersRouter.use("*", requireAuth("SUPERADMIN"));

const kitchenEnum = z.enum(["SNACKS", "MEALS"]);
const roleEnum = z.enum(["STUDENT", "ADMIN", "SUPERADMIN"]);
const schoolEnum = z.enum(["KLH", "DRK"]);
const idSchema = z.string().uuid();

/**
 * `email` is optional for a STUDENT that comes with a roll number, and
 * required (and address-shaped) for everyone else.
 *
 * A student's `email` column is a username, not an address — it holds the bare
 * roll number, exactly as the roster import writes it. Forcing a superadmin
 * adding one student by hand to invent `<roll>@klh.edu.in` would put that one
 * account back in the old shape while every imported classmate is in the new
 * one. Supplying an address still works, so nothing that posts one today
 * breaks; omitting it derives the username from `rollNumber`.
 */
const createUserSchema = z
  .object({
    role: roleEnum,
    name: z.string().min(1),
    email: z.string().min(1).max(255).optional(),
    password: z.string().min(8),
    rollNumber: z.string().min(1).optional(),
    kitchen: kitchenEnum.optional(),
    school: schoolEnum,
  })
  .superRefine((v, ctx) => {
    if (v.role === "STUDENT") {
      if (!v.email && !v.rollNumber) {
        ctx.addIssue({
          code: "custom",
          path: ["rollNumber"],
          message: "A student needs a rollNumber (or an explicit email).",
        });
      }
      return;
    }
    // Staff accounts are reached by real, deliverable addresses.
    if (!v.email || !z.string().email().safeParse(v.email).success) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "A valid email is required." });
    }
  });

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: roleEnum.optional(),
  kitchen: kitchenEnum.nullable().optional(),
  password: z.string().min(8).optional(),
  school: schoolEnum.optional(),
});

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USER_PAGE_SIZE).optional(),
  role: roleEnum.optional(),
  /** "true" / "false" filter on isActive; absent or "all" means both. */
  active: z.enum(["true", "false", "all"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

const bulkSchema = z.object({
  userIds: z.array(idSchema).min(1).max(MAX_BULK_USER_IDS),
});

/**
 * `force` is the only way past PROTECTED_ACCOUNT_EMAILS, and it exists because
 * an admin who genuinely leaves must be disableable. It is opt-in per request
 * rather than implied by "you named one id": deactivating student@klh.edu.in
 * or a kitchen admin from a mis-clicked row in the Users table is a demo
 * outage, and a body flag is the difference between meaning it and not.
 */
const singleSchema = z.object({ force: z.boolean().optional().default(false) });

/** Tolerates an absent or empty body — these endpoints take no required input. */
async function readSingleBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return singleSchema.parse((await c.req.json()) ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) throw err;
    return singleSchema.parse({});
  }
}

/**
 * The admin Users feed — now cursor-paginated, filterable and searchable.
 *
 * RESPONSE SHAPE, and why there are two of them:
 * The existing frontend does `users.filter(...)` straight on the response
 * body, so wrapping the array in an envelope by default would crash the Users
 * page on deploy. A JS array with an extra `nextCursor` property does not
 * survive JSON.stringify either. So, exactly as GET /admin/orders solved the
 * same problem:
 *
 *   default (no `format` param)  -> a bare JSON array, byte-for-byte the old
 *                                   shape, with pagination metadata in the
 *                                   `X-Next-Cursor` / `X-Has-More` /
 *                                   `X-Total-Count` response headers.
 *   ?format=envelope             -> { data, nextCursor, hasMore, total }
 *
 * The one behavioural change old clients see is that they now receive the
 * first DEFAULT_USER_PAGE_SIZE accounts instead of all of them — which is the
 * entire point: at 600 students the old response was the whole table on every
 * page load.
 *
 * Filters: `?role=STUDENT`, `?active=false`, `?search=` (case-insensitive
 * across name, rollNumber and email), `?limit=`, `?cursor=`.
 */
superAdminUsersRouter.get("/", async (c) => {
  const query = listQuerySchema.parse({
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
    role: c.req.query("role"),
    active: c.req.query("active"),
    search: c.req.query("search") ?? c.req.query("q"),
  });

  const options = {
    role: query.role,
    isActive: query.active === undefined || query.active === "all" ? undefined : query.active === "true",
    search: query.search,
  };

  const pool = getRequestPool(c);
  const [page, total] = await Promise.all([
    listUsers(pool, {
      ...options,
      cursor: query.cursor,
      limit: query.limit ?? DEFAULT_USER_PAGE_SIZE,
    }),
    countUsers(pool, options),
  ]);

  c.header("X-Next-Cursor", page.nextCursor ?? "");
  c.header("X-Has-More", String(page.hasMore));
  c.header("X-Total-Count", String(total));
  // Without this the browser cannot read the headers cross-origin, which would
  // leave a paginating frontend unable to fetch page 2.
  c.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Has-More, X-Total-Count");

  if (c.req.query("format") === "envelope") {
    return c.json({ data: page.data, nextCursor: page.nextCursor, hasMore: page.hasMore, total });
  }
  return c.json(page.data);
});

superAdminUsersRouter.post("/", async (c) => {
  const data = createUserSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const user = await createUser(pool, {
    ...data,
    // Guaranteed non-undefined by createUserSchema: a STUDENT without an email
    // has a rollNumber, and every other role has an email.
    email: data.email ?? usernameForRollNumber(data.rollNumber!),
  });
  await logAction(pool, actor.id, "USER_CREATE", "User", user.id, { role: user.role, email: user.email, school: user.school });
  return c.json(user, 201);
});

// ---------------------------------------------------------------------------
// Bulk deactivate / reactivate
//
// Registered ahead of the /:id routes so "bulk" is never a candidate id.
// ---------------------------------------------------------------------------

/**
 * Deactivation is the leaver workflow, and it is deliberately not a delete:
 * Order.studentId is onDelete: Restrict, so deleting a student who has ever
 * ordered fails — and if it did not, it would take the canteen's sales history
 * with it. setUsersActive() also moves `tokensValidFrom`, so the account's live
 * sessions die with it rather than ordering for another twelve hours.
 */
superAdminUsersRouter.post("/bulk/deactivate", async (c) => {
  const { userIds } = bulkSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const result = await setUsersActive(pool, userIds, false, actor.id);
  await logAction(pool, actor.id, "USER_BULK_DEACTIVATE", "User", undefined, {
    requested: result.requested,
    changed: result.changed,
    tokensValidFrom: result.tokensValidFrom,
    userIds: result.changedUsers.map((u) => u.id),
    skipped: result.skipped,
  });
  return c.json(result);
});

superAdminUsersRouter.post("/bulk/reactivate", async (c) => {
  const { userIds } = bulkSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const result = await setUsersActive(pool, userIds, true, actor.id);
  await logAction(pool, actor.id, "USER_BULK_REACTIVATE", "User", undefined, {
    requested: result.requested,
    changed: result.changed,
    userIds: result.changedUsers.map((u) => u.id),
    skipped: result.skipped,
  });
  return c.json(result);
});

superAdminUsersRouter.post("/:id/deactivate", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  const { force } = await readSingleBody(c);
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const result = await setUsersActive(pool, [id], false, actor.id, { allowProtected: force });
  await logAction(pool, actor.id, "USER_DEACTIVATE", "User", id, {
    changed: result.changed,
    forced: force,
    tokensValidFrom: result.tokensValidFrom,
    skipped: result.skipped,
  });
  return c.json(result);
});

superAdminUsersRouter.post("/:id/reactivate", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  // Reactivation restores access; the protected list exists to stop accounts
  // being taken away, so it has nothing to say here.
  const result = await setUsersActive(pool, [id], true, actor.id, { allowProtected: true });
  await logAction(pool, actor.id, "USER_REACTIVATE", "User", id, {
    changed: result.changed,
    skipped: result.skipped,
  });
  return c.json(result);
});

superAdminUsersRouter.patch("/:id", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  const data = updateUserSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  const user = await updateUser(pool, id, data);
  await logAction(pool, actor.id, "USER_UPDATE", "User", id, { fields: Object.keys(data) });
  return c.json(user);
});

superAdminUsersRouter.delete("/:id", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const actor = c.get("user")!;
  await deleteUser(pool, id, actor.id);
  await logAction(pool, actor.id, "USER_DELETE", "User", id);
  return c.body(null, 204);
});
