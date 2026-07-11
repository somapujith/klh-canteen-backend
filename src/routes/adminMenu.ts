import { Router } from "express";
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

export const adminMenuRouter = Router();

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

adminMenuRouter.post("/categories", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const { name, sortOrder } = categorySchema.parse(req.body);
    const category = await createCategory(name, sortOrder, req.user!.kitchen || "SNACKS");
    res.status(201).json(category);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.patch("/categories/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const data = categorySchema.partial().parse(req.body);
    const category = await updateCategory(id, data, req.user!.kitchen || undefined);
    res.json(category);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.delete("/categories/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    await deleteCategory(id, req.user!.kitchen || undefined);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const bulkUpdateSchema = z.object({
  isAvailable: z.boolean().optional(),
  stockQty: z.number().int().min(0).optional(),
});

adminMenuRouter.patch("/categories/:id/bulk-items", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const data = bulkUpdateSchema.parse(req.body);
    await bulkUpdateCategoryItems(id, data, req.user!.kitchen || undefined);
    sseService.broadcastMenuUpdate();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.post("/menu-items", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const data = menuItemSchema.parse(req.body);
    const item = await createMenuItem(data);
    sseService.broadcastMenuUpdate();
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.patch("/menu-items/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const data = menuItemUpdateSchema.parse(req.body);
    const item = await updateMenuItem(id, data, req.user!.kitchen || undefined);
    sseService.broadcastMenuUpdate();
    res.json(item);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.delete("/menu-items/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    await deleteMenuItem(id, req.user!.kitchen || undefined);
    sseService.broadcastMenuUpdate();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
