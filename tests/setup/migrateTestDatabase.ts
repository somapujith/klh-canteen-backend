/**
 * `npm run test:db:migrate` — applies migrations to the TEST database.
 *
 * A thin, guarded wrapper around runMigrations(). It exists so nobody has to
 * hand-type a DATABASE_URL next to a migrate command, which is how the live
 * database gets hit by accident.
 */
import { runMigrations } from "../../scripts/migrate.js";
import { resolveTestEnv } from "./testEnv.js";

const env = resolveTestEnv();
if (!env.hasDatabase) {
  console.error(`Cannot migrate: ${env.reason}`);
  process.exit(1);
}

console.info(
  `[test-db] migrating ${env.target!.user}@${env.target!.host}:${env.target!.port}/${env.target!.database}`,
);

try {
  const applied = await runMigrations(env.databaseUrl!);
  console.info(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
} catch (err) {
  console.error(err);
  process.exit(1);
}
