import { Hono } from "hono";
import { getCategorizedMenu } from "../services/menuService.js";
import { getRequestPrisma } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const menuRouter = new Hono<AppEnv>();

menuRouter.get("/", async (c) => {
  const kitchen = c.req.query("kitchen");
  const isAdmin = c.req.query("admin") === "true";
  const prisma = getRequestPrisma(c);
  const menu = await getCategorizedMenu(prisma, kitchen, isAdmin);
  return c.json(menu);
});
