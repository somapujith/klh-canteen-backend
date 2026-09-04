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
import { superAdminSettingsRouter } from "./routes/superadminSettings.js";
import { telegramRouter } from "./routes/telegram.js";
import { paymentsRouter } from "./routes/payments.js";
import { paymentsEnabled } from "./services/paymentService.js";
import { getPlatformFeePercent } from "./db/schoolSettingsRepo.js";
import { getBindings, getRequestPool } from "./lib/context.js";
import type { School } from "./db/schema.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";
import type { AppEnv } from "./types.js";

/**
 * CORS_ORIGIN is "*" or a comma-separated allowlist. hono/cors' `origin`
 * option takes a string, an array, or a resolver function — a resolver is
 * the only shape that can echo back whichever allowed origin actually made
 * the request, which is required once there's more than one.
 */
function resolveAllowedOrigins(raw: string | undefined) {
  const value = raw || "*";
  if (value === "*") return "*";
  const allowed = value.split(",").map((o) => o.trim()).filter(Boolean);
  return (origin: string) => (allowed.includes(origin) ? origin : undefined);
}

export function createApp() {
  const app = new Hono<AppEnv>();

  // Secure HTTP headers (helmet equivalent).
  //
  // secureHeaders() is the OUTERMOST middleware (registered before every
  // route is mounted), so its post-`next()` header-setting runs LAST — after
  // any route handler has already returned. hono/secure-headers sets its
  // managed headers unconditionally (`ctx.res.headers.set(...)`), which means
  // a route that sets its own "Cross-Origin-Resource-Policy" (routes/menu.ts's
  // public image-serving endpoint, loaded cross-origin from the frontend's
  // <img> tags) would silently have it clobbered back to the "same-origin"
  // default on every response. crossOriginResourcePolicy is disabled here and
  // reapplied by the middleware below, which only sets it when a route hasn't
  // already chosen a value.
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cross-Origin-Resource-Policy")) {
      c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
  });

  // Minimal request logging (pino/pino-http replacement — those are
  // Node-only and don't run on Workers). hono/logger is a plain
  // console.log-based middleware that works on every runtime.
  app.use("*", logger());

  // Restrict CORS to allowed origins in production. CORS_ORIGIN is a
  // comma-separated list (e.g. multiple custom domains for the same
  // frontend) so we resolve per-request against the caller's Origin header.
  app.use("*", async (c, next) => {
    const { CORS_ORIGIN } = env<{ CORS_ORIGIN?: string }>(c);
    return cors({ origin: resolveAllowedOrigins(CORS_ORIGIN) })(c, next);
  });

  // Global rate limit: 100 requests per minute per identity (the JWT subject).
  // NOT per IP — middleware/rateLimit.ts deliberately has no IP keying at all,
  // because campus WiFi NATs the whole student body behind one address. An
  // anonymous request derives no identity and is skipped here; edge volumetric
  // protection is Cloudflare WAF's job.
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

  // Service root. Nothing is mounted at "/", so both platform HEAD / probes and
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

  // Public feature flags the client needs before it can render a correct
  // checkout. Payments being on or off changes what the pay button does, and
  // the client cannot discover that by trying — a checkout POST against a
  // payments-disabled deploy would 503 only after the order was already
  // placed. Nothing secret is exposed: this reports THAT payments are on,
  // never the credentials that make them work.
  app.get("/config", async (c) => {
    const bindings = getBindings(c);
    // Default "KLH" so existing callers that never passed `school` keep
    // getting exactly what they got before this param existed.
    const rawSchool = c.req.query("school");
    const school: School = rawSchool === "DRK" ? "DRK" : "KLH";
    const pool = getRequestPool(c);
    const platformFeePercent = await getPlatformFeePercent(pool, school);
    return c.json({ paymentsEnabled: paymentsEnabled(bindings), platformFeePercent });
  });

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
  app.route("/superadmin/settings", superAdminSettingsRouter);
  // Student Telegram link + bot webhook (students only; staff/guest never linked).
  app.route("/telegram", telegramRouter);
  // UPI payments. POST /payments/webhook is public and authenticated by HMAC
  // signature over the raw body rather than by session — see routes/payments.ts.
  app.route("/payments", paymentsRouter);

  app.onError(async (err, c) => {
    const res = await errorHandler(err, c);
    const { CORS_ORIGIN } = env<{ CORS_ORIGIN?: string }>(c);
    const resolver = resolveAllowedOrigins(CORS_ORIGIN);
    const allowed =
      typeof resolver === "function" ? resolver(c.req.header("Origin") ?? "") : resolver;
    if (allowed) res.headers.set("Access-Control-Allow-Origin", allowed);
    return res;
  });

  return app;
}
