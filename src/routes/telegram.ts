import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { logAction } from "../services/auditService.js";
import {
  getTelegramStatus,
  startTelegramLink,
  unlinkTelegram,
  handleTelegramUpdate,
  verifyWebhookSecret,
} from "../services/telegramService.js";
import { getBindings, getRequestPool } from "../lib/context.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { AppEnv } from "../types.js";

/**
 * Student Telegram link API + bot webhook.
 *
 * Callers: mounted from app.ts at /telegram.
 * Endpoints: GET/POST/DELETE /telegram (STUDENT), POST /telegram/webhook (public).
 * User: "integrate this with all the students only... link... delink... order logs"
 */
export const telegramRouter = new Hono<AppEnv>();

const linkLimiter = rateLimit({
  prefix: "telegram-link",
  windowSeconds: 60,
  max: 10,
  code: "TOO_MANY_REQUESTS",
  message: "Too many Telegram link attempts, please wait a minute.",
});

telegramRouter.get("/", requireAuth("STUDENT"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const status = await getTelegramStatus(pool, getBindings(c), user.id);
  return c.json(status);
});

telegramRouter.post("/link", requireAuth("STUDENT"), linkLimiter, async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const result = await startTelegramLink(pool, getBindings(c), user.id);
  await logAction(pool, user.id, "TELEGRAM_LINK_STARTED", "User", user.id, {
    botUsername: result.botUsername,
    expiresAt: result.expiresAt,
  });
  return c.json(result);
});

telegramRouter.delete("/", requireAuth("STUDENT"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const result = await unlinkTelegram(pool, user.id);
  await logAction(pool, user.id, "TELEGRAM_UNLINKED", "User", user.id);
  return c.json(result);
});

telegramRouter.post("/webhook", async (c) => {
  const bindings = getBindings(c);
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!verifyWebhookSecret(bindings, secret)) {
    return c.json({ error: { message: "Invalid webhook secret", code: "FORBIDDEN" } }, 403);
  }

  const pool = getRequestPool(c);
  const update = await c.req.json();
  await handleTelegramUpdate(pool, bindings, update);
  return c.json({ ok: true });
});
