import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { sseService } from "../services/sseService.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { AppEnv } from "../types.js";

export const eventsRouter = new Hono<AppEnv>();

eventsRouter.get("/stream", requireAuth(), async (c) => {
  const user = c.get("user")!;
  const stream = await sseService.connect(c.env, user.id);
  if (!stream) {
    throw new ApiError(503, "SSE_UNAVAILABLE", "Real-time events are unavailable in this environment");
  }
  return stream;
});
