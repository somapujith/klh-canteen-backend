import { Router } from "express";
import { getCategorizedMenu } from "../services/menuService.js";

export const menuRouter = Router();

menuRouter.get("/", async (req, res, next) => {
  try {
    const kitchen = req.query.kitchen as string | undefined;
    const isAdmin = req.query.admin === "true";
    const menu = await getCategorizedMenu(kitchen, isAdmin);
    res.json(menu);
  } catch (err) {
    next(err);
  }
});
