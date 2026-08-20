import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { openOrderForAdmin, updateOrderStatus, getAllOrders, getAdminStats } from "../services/orderService.js";
import { sseService } from "../services/sseService.js";
import { logAction } from "../services/auditService.js";

export const adminOrdersRouter = Router();

const idParamSchema = z.string().uuid();
const statusBodySchema = z.object({ status: z.enum(["PREPARING", "COOKED", "DELIVERED"]) });
const ACTIVE_STATUSES = ["PENDING", "PREPARING", "COOKED"];

adminOrdersRouter.get("/", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const activeOnly = req.query.active === "true";
    const orders = await getAllOrders(req.user!.kitchen || undefined, activeOnly ? ACTIVE_STATUSES : undefined);
    const serialized = orders.map((order) => ({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) }));
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

adminOrdersRouter.get("/:id", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const order = await openOrderForAdmin(id, req.user!.id, req.user!.kitchen || undefined);
    sseService.broadcastOrderBoardUpdate();
    res.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.patch("/:id/status", requireAuth("ADMIN"), async (req, res, next) => {
  try {
    const id = idParamSchema.parse(req.params.id);
    const { status } = statusBodySchema.parse(req.body);
    const order = await updateOrderStatus(id, status, req.user!.kitchen || undefined);
    if (!req.user!.kitchen || req.user!.kitchen !== order.kitchen) {
      await logAction(req.user!.id, "ORDER_STATUS_OVERRIDE", "Order", order.id, { kitchen: order.kitchen, status });
    }
    if (status === "DELIVERED") {
      sseService.notifyOrderUpdate(order.studentId, order.id, order.status);
      sseService.broadcastMenuUpdate();
    }
    sseService.broadcastOrderBoardUpdate();
    res.json({ ...order, totalAmount: Number(order.totalAmount).toFixed(2) });
  } catch (err) {
    next(err);
  }
});
