import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";

/**
 * The app is now a Hono instance (app.fetch), not a Node request handler, so
 * supertest can no longer bind to it directly like it did with Express.
 * @hono/node-server's serve() adapts app.fetch onto a real Node http.Server,
 * which supertest can use exactly as before. We wait for the "listening"
 * callback so supertest never races an unbound server (serve() itself
 * returns synchronously before the underlying socket is guaranteed to be
 * bound).
 */
export function startTestServer(app: Hono<any>): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, () => resolve(server));
  });
}
