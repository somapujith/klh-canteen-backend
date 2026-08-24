/**
 * Runs ONCE, in the vitest main process, before any worker is spawned and
 * therefore before any test file's hooks exist.
 *
 * Responsibilities, in order:
 *   1. Resolve the test environment — which throws if DATABASE_URL is unsafe.
 *   2. If no test database is configured, say so loudly and return; the
 *      database-backed suites will skip. It never falls back to `.env`.
 *   3. Apply migrations to the test database.
 *   4. Measure the drift between what those migrations produce and what
 *      prisma/schema.prisma declares, publish it to the suite, and reconcile
 *      the test database so the app can actually run against it.
 *   5. Claim the database with the marker (see marker.ts).
 */
import { spawnSync } from "node:child_process";
import { Pool } from "@neondatabase/serverless";
import type { TestProject } from "vitest/node";
import { resolveTestEnv } from "./testEnv.js";
import { configureNeonForLocalPostgres } from "./neonLocal.js";
import { ensureTestDatabaseMarker } from "./marker.js";
import { REPO_ROOT } from "./databaseGuard.js";

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
    project.provide("schemaDrift", null);
    return;
  }

  configureNeonForLocalPostgres(env.target);

  console.info(
    `[test-db] target: ${env.target!.user}@${env.target!.host}:${env.target!.port}/${env.target!.database}`,
  );

  let drift: string | null = null;

  if (process.env.SKIP_TEST_MIGRATIONS !== "1") {
    prisma(env.databaseUrl!, ["migrate", "deploy"]);

    drift = await measureMigrationDrift(env.databaseUrl!);

    if (drift) {
      console.warn(
        [
          "",
          "----------------------------------------------------------------------",
          "  SCHEMA DRIFT: prisma/migrations does NOT reproduce prisma/schema.prisma.",
          "  A database rebuilt from migrations alone is missing columns the app",
          "  needs. The test database is being reconciled with `prisma db push` so",
          "  the suite can run; production databases are NOT self-healing.",
          "",
          drift.replace(/^/gm, "    "),
          "----------------------------------------------------------------------",
          "",
        ].join("\n"),
      );
      prisma(env.databaseUrl!, ["db", "push", "--accept-data-loss"]);
    }
  }

  // Published to every worker; tests/schemaDrift.test.ts asserts it is null.
  project.provide("schemaDrift", drift);

  await ensureTestDatabaseMarker(env.databaseUrl!);
}


/**
 * Does the migration history reproduce prisma/schema.prisma?
 *
 * Measured against a THROWAWAY SHADOW DATABASE that prisma builds from
 * `prisma/migrations` alone, not against the working test database. Diffing
 * the working database would give a different answer on the second run — the
 * reconciliation below has already applied the missing schema to it — and a
 * drift check that quietly stops reporting is worse than none.
 *
 * Returns the missing SQL, or null when the migrations are complete (or when
 * the check could not be performed, e.g. a managed host that will not let us
 * create a shadow database — reported, never silently treated as "clean").
 */
async function measureMigrationDrift(databaseUrl: string): Promise<string | null> {
  const shadowUrl = shadowUrlFor(databaseUrl);

  try {
    await ensureShadowDatabase(shadowUrl);
    await resetShadowSchema(shadowUrl);
  } catch (err) {
    console.warn(
      `[test-db] migration drift check skipped: could not create a shadow database (${(err as Error).message})`,
    );
    return null;
  }

  // Built from `prisma/migrations` and nothing else, then compared to the
  // schema file. Both commands run against the shadow URL.
  prisma(shadowUrl, ["migrate", "deploy"]);
  const output = prisma(shadowUrl, [
    "migrate",
    "diff",
    // "from" is the datasource in prisma.config.ts, which resolves to the
    // DATABASE_URL passed above — here, the shadow database.
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
  ]).trim();

  if (!output || /^--\s*This is an empty migration/im.test(output)) return null;
  return output;
}

/**
 * Empties the shadow database so the migrations are replayed from nothing.
 * Named-guarded by ensureShadowDatabase's caller; this only ever runs against
 * `<test database>_shadow`.
 */
async function resetShadowSchema(shadowUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: shadowUrl });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query("CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
}

/** `<db>` -> `<db>_shadow`, keeping every other part of the URL identical. */
function shadowUrlFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/^\//, "")}_shadow`;
  return url.toString();
}

async function ensureShadowDatabase(shadowUrl: string): Promise<void> {
  const url = new URL(shadowUrl);
  const name = url.pathname.replace(/^\//, "");
  // A shadow database is created and reset by prisma; it must never be able to
  // resolve to anything but a test database.
  if (!/test/i.test(name)) throw new Error(`refusing to create shadow database "${name}"`);

  const admin = new URL(shadowUrl);
  admin.pathname = "/postgres";
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rows.length === 0) {
      await pool.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Runs the prisma CLI against the TEST database and nothing else.
 *
 * DATABASE_URL is passed explicitly, and DOTENV_CONFIG_PATH is repointed
 * because prisma.config.ts does `import "dotenv/config"` — which would
 * otherwise read `.env`, i.e. the live database.
 */
function prisma(databaseUrl: string, args: string[]): string {
  const result = spawnSync("npx", ["prisma", ...args], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl, DOTENV_CONFIG_PATH: ".env.test" },
  });

  if (result.status !== 0) {
    throw new Error(
      `prisma ${args.join(" ")} failed against the test database:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

declare module "vitest" {
  interface ProvidedContext {
    /** Drift SQL, or null when migrations reproduce the schema exactly. */
    schemaDrift: string | null;
  }
}
