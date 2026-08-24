import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

/**
 * Plain-Node entrypoint for platforms without a Workers runtime (e.g. Render).
 * `getBindings()` (src/lib/context.ts) already falls back to `process.env`
 * here via hono/adapter's `env()`, so no other code needs to change to run
 * under Node — this file only exists because Workers' `export default {
 * fetch }` convention (src/index.ts) has nothing that binds a TCP port.
 *
 * Durable Object bindings (ORDER_EVENTS_HUB, RATE_LIMITER_HUB) and the KV
 * rate limiter resolve to undefined under Node and no-op gracefully — see
 * their respective modules. Realtime SSE broadcast and the DO-based rate
 * limiter are therefore inert here, not broken; everything else is unaffected.
 */
const app = createApp();
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`KLH Canteen backend (Node/Render) listening on port ${info.port}`);
});
