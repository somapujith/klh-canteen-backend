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
} from "../services/menuService.js";

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
    const category = await createCategory(name, sortOrder);
    res.status(201).json(category);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.patch("/categories/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const data = categorySchema.partial().parse(req.body);
    const category = await updateCategory(id, data);
    res.json(category);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.delete("/categories/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    await deleteCategory(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.post("/menu-items", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const data = menuItemSchema.parse(req.body);
    const item = await createMenuItem(data);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.patch("/menu-items/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const data = menuItemUpdateSchema.parse(req.body);
    const item = await updateMenuItem(id, data);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

adminMenuRouter.delete("/menu-items/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    await deleteMenuItem(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
