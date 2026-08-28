/**
 * Applies db/migrations/<dir>/migration.sql to DATABASE_URL, in lexical
 * (= chronological, timestamp-prefixed dirname) order, tracking what has
 * already run in a `_migrations` table. Replaces `prisma migrate deploy`.
 *
 * The table is deliberately named differently from Prisma's own
 * `_prisma_migrations`, so a leftover Prisma-era tracking table in an
 * existing database is never mistaken for this one.
 *
 * Usable both as a CLI (`tsx scripts/migrate.ts`, reads DATABASE_URL from
 * the environment) and as a library (`import { runMigrations }`) — the test
 * harness (tests/setup/migrateTestDatabase.ts, globalSetup.ts) calls the
 * function directly instead of shelling out.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const { rows: done } = await pool.query<{ name: string }>(`SELECT "name" FROM "_migrations"`);
    const doneSet = new Set(done.map((r) => r.name));

    const dirs = readdirSync(MIGRATIONS_DIR)
      .filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
      .sort();

    for (const dir of dirs) {
      if (doneSet.has(dir)) continue;
      const sqlText = readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sqlText);
        await client.query(`INSERT INTO "_migrations" ("name") VALUES ($1)`, [dir]);
        await client.query("COMMIT");
        applied.push(dir);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${dir} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}

// pathToFileURL, not a `file://${argv[1]}` template: on Windows argv[1] is a
// backslashed drive path ("H:\...") while import.meta.url is a three-slash file URL
// ("file:///H:/..."), so the template never matches and the CLI silently does
// nothing — exiting 0 having applied no migrations.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI-only, matching scripts/seedAdmin.ts. Importers (the test harness)
  // resolve their own DATABASE_URL and must not have .env loaded under them —
  // that is exactly how the live database gets migrated by accident.
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
