/**
 * The app reaches Postgres through @neondatabase/serverless (see
 * src/lib/prisma.ts), which speaks the Postgres protocol over a WebSocket
 * rather than raw TCP. A plain local Postgres container therefore cannot be
 * reached without a WebSocket terminator in front of it — that is the
 * `wsproxy-test` service in docker-compose.test.yml.
 *
 * This module points the Neon driver at that proxy. It is only applied for
 * local targets; a real Neon branch already terminates WebSockets itself.
 *
 * These are process-global mutations on the driver, which is precisely why
 * they live in a test-only module and are never imported by src/.
 */
import { neonConfig } from "@neondatabase/serverless";
import type { ParsedTarget } from "./databaseGuard.js";

export function configureNeonForLocalPostgres(target: ParsedTarget | undefined): void {
  if (!target?.isLocal) return;

  const proxy = (process.env.NEON_WS_PROXY || "localhost:55480").trim();

  neonConfig.wsProxy = () => `${proxy}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;

  // Node 22+ ships a global WebSocket; fall back to `ws` if it is missing.
  if (typeof globalThis.WebSocket === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    neonConfig.webSocketConstructor = require("ws");
  }
}
