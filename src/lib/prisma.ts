import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

/**
 * Workers tears down every I/O object a request created once that request
 * ends, sockets included. A PrismaClient memoized in module scope therefore
 * hangs the *next* request that reuses it — workerd kills it with "your
 * Worker's code had hung and would never generate a response", which reaches
 * the browser as a header-less 500 (i.e. a phantom CORS failure). So on
 * Workers each call builds a fresh client, memoized per-request in
 * getRequestPrisma() rather than globally.
 *
 * Under Node (vitest, seed scripts) there is no such teardown and a client per
 * call would leak connections, so that runtime keeps the original memoization.
 */
const isWorkers =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let cached: { url: string; client: PrismaClient } | undefined;

export function createPrisma(databaseUrl: string): PrismaClient {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const adapter = new PrismaNeon({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export function getPrisma(databaseUrl: string): PrismaClient {
  if (isWorkers) return createPrisma(databaseUrl);
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (cached && cached.url === databaseUrl) return cached.client;

  const client = createPrisma(databaseUrl);
  cached = { url: databaseUrl, client };
  return client;
}
