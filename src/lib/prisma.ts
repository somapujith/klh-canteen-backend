import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// Workers isolates can be reused across requests, so memoize one PrismaClient
// per connection string instead of reading process.env at module load (which
// doesn't exist on Workers) or reconnecting on every request. Keyed by the
// connection string itself so a changed DATABASE_URL (e.g. across test runs)
// still gets a fresh client rather than serving a stale cached one.
let cached: { url: string; client: PrismaClient } | undefined;

export function getPrisma(databaseUrl: string): PrismaClient {
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (cached && cached.url === databaseUrl) return cached.client;

  const adapter = new PrismaNeon({ connectionString: databaseUrl });
  const client = new PrismaClient({ adapter });
  cached = { url: databaseUrl, client };
  return client;
}
