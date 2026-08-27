/**
 * Runs ONCE, in the vitest main process, before any worker is spawned and
 * therefore before any test file's hooks exist.
 *
 * Responsibilities, in order:
 *   1. Resolve the test environment — which throws if DATABASE_URL is unsafe.
 *   2. If no test database is configured, say so loudly and return; the
 *      database-backed suites will skip. It never falls back to `.env`.
 *   3. Apply migrations to the test database.
 *   4. Claim the database with the marker (see marker.ts).
 */
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../scripts/migrate.js";
import { resolveTestEnv } from "./testEnv.js";
import { ensureTestDatabaseMarker } from "./marker.js";

export default async function globalSetup(project: TestProject): Promise<void> {
  const env = resolveTestEnv();

  if (!env.hasDatabase) {
    console.warn(
      [
        "",
        "----------------------------------------------------------------------",
        "  NO TEST DATABASE — database-backed tests will SKIP.",
        `  ${env.reason}`,
        "  The suite will NOT fall back to .env. See TESTING.md.",
        "----------------------------------------------------------------------",
        "",
      ].join("\n"),
    );
    return;
  }

  console.info(
    `[test-db] target: ${env.target!.user}@${env.target!.host}:${env.target!.port}/${env.target!.database}`,
  );

  if (process.env.SKIP_TEST_MIGRATIONS !== "1") {
    await runMigrations(env.databaseUrl!);
  }

  await ensureTestDatabaseMarker(env.databaseUrl!);
}
