import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getOrderByToken, deliverOrder, getAllOrders, getAdminStats } from "../services/orderService.js";
import { sseService } from "../services/sseService.js";
import { logAction } from "../services/auditService.js";

export const adminOrdersRouter = Router();

const idParamSchema = z.string().uuid();
const tokenParamSchema = z.string().min(1);

adminOrdersRouter.get("/", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const orders = await getAllOrders(req.user!.kitchen || undefined);
    // Serialize totalAmount for frontend consistency
    const serialized = orders.map((order) => ({
      ...order,
      totalAmount: Number(order.totalAmount).toFixed(2),
    }));
    res.json(serialized);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.get("/stats", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const stats = await getAdminStats(req.user!.kitchen || undefined);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.get("/scan/:token", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const token = tokenParamSchema.parse(req.params.token);
    const order = await getOrderByToken(token, req.user!.kitchen || undefined, req.user!.id);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.post("/:id/deliver", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const order = await deliverOrder(id, req.user!.kitchen || undefined);
    if (!req.user!.kitchen || req.user!.kitchen !== order.kitchen) {
      await logAction(req.user!.id, "ORDER_DELIVER_OVERRIDE", "Order", order.id, { kitchen: order.kitchen });
    }
    sseService.notifyOrderUpdate(order.studentId, order.id, order.status);
    sseService.broadcastMenuUpdate();
    res.json(order);
  } catch (err) {
    next(err);
  }
});
