import { Router } from "express";
import { getCategorizedMenu } from "../services/menuService.js";

export const menuRouter = Router();

menuRouter.get("/", async (_req, res, next) => {
  try {
    const menu = await getCategorizedMenu();
    res.json(menu);
  } catch (err) {
    next(err);
  }
});
