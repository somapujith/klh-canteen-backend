import { Hono } from "hono";
import { getCategorizedMenu } from "../services/menuService.js";
import { getRequestPool } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const menuRouter = new Hono<AppEnv>();

menuRouter.get("/", async (c) => {
  const kitchen = c.req.query("kitchen");
  const isAdmin = c.req.query("admin") === "true";
  const pool = getRequestPool(c);
  const menu = await getCategorizedMenu(pool, kitchen, isAdmin);
  return c.json(menu);
});
