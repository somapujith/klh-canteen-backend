import express, { Express } from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { adminMenuRouter } from "./routes/adminMenu.js";
import { adminStudentsRouter } from "./routes/adminStudents.js";
import { ordersRouter } from "./routes/orders.js";
import { adminOrdersRouter } from "./routes/adminOrders.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp(): Express {
  const app = express();
  // Allow all origins to avoid CORS issues from Vercel preview links or misconfigurations
  app.use(cors({ origin: "*" }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/menu", menuRouter);
  app.use("/admin", adminMenuRouter);
  app.use("/admin/students", adminStudentsRouter);
  app.use("/orders", ordersRouter);
  app.use("/admin/orders", adminOrdersRouter);

  app.use(errorHandler);

  return app;
}
