import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { sseService } from "../services/sseService.js";

export const eventsRouter = Router();

eventsRouter.get("/stream", requireAuth(), (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const userId = req.user!.id;
  sseService.addClient(userId, res);
});
