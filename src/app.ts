import express, { Express } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { adminMenuRouter } from "./routes/adminMenu.js";
import { adminStudentsRouter } from "./routes/adminStudents.js";
import { ordersRouter } from "./routes/orders.js";
import { adminOrdersRouter } from "./routes/adminOrders.js";
import { eventsRouter } from "./routes/events.js";
import { superAdminRouter } from "./routes/superadmin.js";
import { superAdminUsersRouter } from "./routes/superadminUsers.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp(): Express {
  const app = express();
  // Secure HTTP headers
  app.use(helmet());

  // Structured production logging
  app.use(pinoHttp({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
  }));

  // Restrict CORS to allowed origin in production
  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
  app.use(express.json());

  // Global rate limit: 100 requests per minute per IP
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: "Too many requests, please try again later.", code: "TOO_MANY_REQUESTS" } }
  });
  app.use(globalLimiter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/menu", menuRouter);
  app.use("/admin", adminMenuRouter);
  app.use("/admin/students", adminStudentsRouter);
  app.use("/orders", ordersRouter);
  app.use("/admin/orders", adminOrdersRouter);
  app.use("/events", eventsRouter);
  app.use("/superadmin", superAdminRouter);
  app.use("/superadmin/users", superAdminUsersRouter);

  app.use(errorHandler);

  return app;
}
