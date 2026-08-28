import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertSingleInstance, createNodeEventsHub } from "./services/nodeEventsHub.js";

/**
 * Plain-Node entrypoint for local development and any host without a Workers
 * runtime. Production deploys to Cloudflare Workers (src/index.ts).
 * `getBindings()` (src/lib/context.ts) already falls back to `process.env`
 * here via hono/adapter's `env()`, so no other code needs to change to run
 * under Node — this file only exists because Workers' `export default {
 * fetch }` convention (src/index.ts) has nothing that binds a TCP port.
 *
 * REALTIME. ORDER_EVENTS_HUB is a Durable Object and therefore does not exist
 * under Node, which used to make every emit a no-op and answer
 * `GET /events/stream` with 503 — the kitchen board never updated under Node.
 * We install an in-process hub speaking the DO's wire contract instead (see
 * services/nodeEventsHub.ts) and pass it as the request bindings, which
 * getBindings() overlays onto process.env. It fans out within THIS process:
 * correct for one instance, wrong for two — see the scope limit in that module.
 *
 * RATE_LIMITER_HUB is still unbound here; the limiter no-ops gracefully.
 */
const app = createApp();
const port = Number(process.env.PORT ?? 4000);

assertSingleInstance();
const ORDER_EVENTS_HUB = createNodeEventsHub();

// @hono/node-server calls app.fetch(request) with no bindings argument, so the
// hub is handed over here. Everything else still comes from process.env.
const fetch = (request: Request) => app.fetch(request, { ORDER_EVENTS_HUB } as never);

serve({ fetch, port }, (info) => {
  console.log(`KLH Canteen backend (plain Node) listening on port ${info.port}`);
  console.log(`[hub] in-process realtime hub active (SSE only, single instance)`);
});
