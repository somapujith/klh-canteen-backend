import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { env } from "hono/adapter";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { adminMenuRouter } from "./routes/adminMenu.js";
import { adminStudentsRouter } from "./routes/adminStudents.js";
import { ordersRouter } from "./routes/orders.js";
import { guestRouter } from "./routes/guest.js";
import { adminOrdersRouter } from "./routes/adminOrders.js";
import { eventsRouter } from "./routes/events.js";
import { superAdminRouter } from "./routes/superadmin.js";
import { superAdminUsersRouter } from "./routes/superadminUsers.js";
import { superAdminStudentsRouter } from "./routes/superadminStudents.js";
import { superAdminCohortsRouter } from "./routes/superadminCohorts.js";
import { superAdminExportsRouter } from "./routes/superadminExports.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";
import type { AppEnv } from "./types.js";

export function createApp() {
  const app = new Hono<AppEnv>();

  // Secure HTTP headers (helmet equivalent)
  app.use("*", secureHeaders());

  // Minimal request logging (pino/pino-http replacement — those are
  // Node-only and don't run on Workers). hono/logger is a plain
  // console.log-based middleware that works on every runtime.
  app.use("*", logger());

  // Restrict CORS to allowed origin in production
  app.use("*", async (c, next) => {
    const { CORS_ORIGIN } = env<{ CORS_ORIGIN?: string }>(c);
    return cors({ origin: CORS_ORIGIN || "*" })(c, next);
  });

  // Global rate limit: 100 requests per minute per IP
  app.use(
    "*",
    rateLimit({
      prefix: "global",
      windowSeconds: 60,
      max: 100,
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests, please try again later.",
    })
  );

  // Service root. Nothing is mounted at "/", so both Render's HEAD / probe and
  // anyone opening the base URL in a browser used to get a bare 404, which
  // reads like a broken deploy in the logs. Answer with a small identity
  // document instead — no data, no auth, just proof of what is running.
  app.get("/", (c) =>
    c.json({
      service: "klh-canteen-backend",
      status: "ok",
      health: "/health",
    })
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/auth", authRouter);
  app.route("/menu", menuRouter);
  app.route("/admin", adminMenuRouter);
  app.route("/admin/students", adminStudentsRouter);
  app.route("/orders", ordersRouter);
  // Walk-up guest ordering (no account). Session-scoped reads only —
  // see the security note at the top of routes/guest.ts.
  app.route("/guest", guestRouter);
  app.route("/admin/orders", adminOrdersRouter);
  app.route("/events", eventsRouter);
  app.route("/superadmin", superAdminRouter);
  app.route("/superadmin/users", superAdminUsersRouter);
  app.route("/superadmin/students", superAdminStudentsRouter);
  // Year-end cohort promotion (dry-run by default) and reconciliation exports.
  app.route("/superadmin/cohorts", superAdminCohortsRouter);
  app.route("/superadmin/exports", superAdminExportsRouter);

  app.onError(async (err, c) => {
    const res = await errorHandler(err, c);
    const { CORS_ORIGIN } = env<{ CORS_ORIGIN?: string }>(c);
    res.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN || "*");
    return res;
  });

  return app;
}
