import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { listUsers, createUser, updateUser, deleteUser } from "../services/userAdminService.js";
import { logAction } from "../services/auditService.js";

export const superAdminUsersRouter = Router();

superAdminUsersRouter.use(requireAuth("SUPERADMIN"));

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

superAdminUsersRouter.get("/", async (_req, res, next) => {
  try {
    const users = await listUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

superAdminUsersRouter.post("/", async (req, res, next) => {
  try {
    const data = createUserSchema.parse(req.body);
    const user = await createUser(data);
    await logAction(req.user!.id, "USER_CREATE", "User", user.id, { role: user.role, email: user.email });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

superAdminUsersRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const data = updateUserSchema.parse(req.body);
    const user = await updateUser(id, data);
    await logAction(req.user!.id, "USER_UPDATE", "User", id, { fields: Object.keys(data) });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

superAdminUsersRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await deleteUser(id, req.user!.id);
    await logAction(req.user!.id, "USER_DELETE", "User", id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
