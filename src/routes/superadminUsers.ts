import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { listUsers, createUser, updateUser, deleteUser } from "../services/userAdminService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPrisma } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const superAdminUsersRouter = new Hono<AppEnv>();

superAdminUsersRouter.use("*", requireAuth("SUPERADMIN"));

const kitchenEnum = z.enum(["SNACKS", "MEALS"]);
const roleEnum = z.enum(["STUDENT", "ADMIN", "SUPERADMIN"]);

const createUserSchema = z.object({
  role: roleEnum,
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  rollNumber: z.string().min(1).optional(),
  kitchen: kitchenEnum.optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: roleEnum.optional(),
  kitchen: kitchenEnum.nullable().optional(),
  password: z.string().min(8).optional(),
});

superAdminUsersRouter.get("/", async (c) => {
  const prisma = getRequestPrisma(c);
  const users = await listUsers(prisma);
  return c.json(users);
});

superAdminUsersRouter.post("/", async (c) => {
  const data = createUserSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const actor = c.get("user")!;
  const user = await createUser(prisma, data);
  await logAction(prisma, actor.id, "USER_CREATE", "User", user.id, { role: user.role, email: user.email });
  return c.json(user, 201);
});

superAdminUsersRouter.patch("/:id", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const data = updateUserSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const actor = c.get("user")!;
  const user = await updateUser(prisma, id, data);
  await logAction(prisma, actor.id, "USER_UPDATE", "User", id, { fields: Object.keys(data) });
  return c.json(user);
});

superAdminUsersRouter.delete("/:id", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const actor = c.get("user")!;
  await deleteUser(prisma, id, actor.id);
  await logAction(prisma, actor.id, "USER_DELETE", "User", id);
  return c.body(null, 204);
});
