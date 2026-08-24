/**
 * `npm run test:db:migrate` — applies migrations to the TEST database.
 *
 * A thin, guarded wrapper around `prisma migrate deploy`. It exists so nobody
 * has to hand-type a DATABASE_URL next to a migrate command, which is how the
 * live database gets hit by accident.
 */
import { spawnSync } from "node:child_process";
import { resolveTestEnv } from "./testEnv.js";
import { REPO_ROOT } from "./databaseGuard.js";

const env = resolveTestEnv();
if (!env.hasDatabase) {
  console.error(`Cannot migrate: ${env.reason}`);
  process.exit(1);
}

console.info(
  `[test-db] migrating ${env.target!.user}@${env.target!.host}:${env.target!.port}/${env.target!.database}`,
);

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: env.databaseUrl!, DOTENV_CONFIG_PATH: ".env.test" },
});
process.exit(result.status ?? 1);
