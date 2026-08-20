import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  createCategory,
  updateCategory,
  deleteCategory,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  bulkUpdateCategoryItems,
} from "../services/menuService.js";
import { sseService } from "../services/sseService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPrisma, getBindings } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminMenuRouter = new Hono<AppEnv>();

const categorySchema = z.object({ name: z.string().min(1), sortOrder: z.number().int().default(0) });
const menuItemSchema = z.object({
  name: z.string().min(1),
  imageUrl: z.string().url(),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/),
  stockQty: z.number().int().min(0),
  categoryId: z.string().uuid(),
});
const menuItemUpdateSchema = menuItemSchema.partial();
const idParamSchema = z.string().uuid();

adminMenuRouter.post("/categories", requireAuth("ADMIN"), async (c) => {
  const { name, sortOrder } = categorySchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const category = await createCategory(prisma, name, sortOrder, user.kitchen || "SNACKS");
  return c.json(category, 201);
});

adminMenuRouter.patch("/categories/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = categorySchema.partial().parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const category = await updateCategory(prisma, id, data, user.kitchen || undefined);
  return c.json(category);
});

adminMenuRouter.delete("/categories/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  await deleteCategory(prisma, id, user.kitchen || undefined);
  await logAction(prisma, user.id, "CATEGORY_DELETE", "Category", id);
  return c.body(null, 204);
});

const bulkUpdateSchema = z.object({
  isAvailable: z.boolean().optional(),
  stockQty: z.number().int().min(0).optional(),
});

adminMenuRouter.patch("/categories/:id/bulk-items", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = bulkUpdateSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  await bulkUpdateCategoryItems(prisma, id, data, user.kitchen || undefined);
  await logAction(prisma, user.id, "CATEGORY_BULK_UPDATE", "Category", id, data);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json({ success: true });
});

adminMenuRouter.post("/menu-items", requireAuth("ADMIN"), async (c) => {
  const data = menuItemSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const item = await createMenuItem(prisma, data);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json(item, 201);
});

adminMenuRouter.patch("/menu-items/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = menuItemUpdateSchema.parse(await c.req.json());
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  const item = await updateMenuItem(prisma, id, data, user.kitchen || undefined);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json(item);
});

adminMenuRouter.delete("/menu-items/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const prisma = getRequestPrisma(c);
  const user = c.get("user")!;
  await deleteMenuItem(prisma, id, user.kitchen || undefined);
  await logAction(prisma, user.id, "MENU_ITEM_DELETE", "MenuItem", id);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.body(null, 204);
});
