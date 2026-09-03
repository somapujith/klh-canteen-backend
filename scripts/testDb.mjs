#!/usr/bin/env node
/**
 * Local test database, up and down.
 *
 * Two containers, not one. `@neondatabase/serverless` talks WebSockets to
 * Neon's endpoint rather than the raw Postgres wire protocol, so a plain
 * `postgres:16` container is invisible to it — the connection fails with an
 * opaque ErrorEvent that names no cause. `neondatabase/wsproxy` bridges the
 * two, and tests/setup/testEnv.ts points the driver at it whenever the target
 * host is local.
 *
 *   npm run test:db:up     start both, wait until ready
 *   npm run test:db:down   remove both
 *
 * Everything here is disposable. The suite TRUNCATEs every table between
 * tests, and the guard in tests/setup/ refuses to run against anything that
 * does not look like a throwaway database.
 */
import { execFileSync, spawnSync } from "node:child_process";

const NETWORK = "klh-test-net";
const DB = "klh-testdb";
const PROXY = "klh-wsproxy";
const DB_PORT = "55433";
const PROXY_PORT = "55434";

function docker(args, { quiet = true } = {}) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
}

function requireDocker() {
  const probe = docker(["info"]);
  if (probe.status !== 0) {
    console.error("\nDocker is not running. Start Docker Desktop and try again.\n");
    process.exit(1);
  }
}

function up() {
  requireDocker();

  // `|| true` semantics: an existing network is success, not an error.
  docker(["network", "create", NETWORK]);

  // Remove any previous pair first, so `up` is repeatable rather than
  // failing on a name clash from an earlier run.
  docker(["rm", "-f", DB]);
  docker(["rm", "-f", PROXY]);

  console.log("starting postgres…");
  const db = docker([
    "run", "-d", "--name", DB, "--network", NETWORK,
    "-e", "POSTGRES_PASSWORD=klh",
    "-e", "POSTGRES_USER=klh",
    "-e", "POSTGRES_DB=klh_canteen_test",
    "-p", `${DB_PORT}:5432`,
    "postgres:16-alpine",
  ]);
  if (db.status !== 0) {
    console.error(db.stderr || "failed to start postgres");
    process.exit(1);
  }

  // Wait for real readiness, not just container start: the first migration
  // otherwise races Postgres' own initialisation and fails.
  process.stdout.write("waiting for postgres");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const probe = docker(["exec", DB, "pg_isready", "-U", "klh", "-d", "klh_canteen_test"]);
    if (probe.status === 0) {
      ready = true;
      break;
    }
    process.stdout.write(".");
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { timeout: 2000 });
  }
  console.log(ready ? " ready" : " timed out");
  if (!ready) process.exit(1);

  console.log("starting wsproxy…");
  // ALLOW_ADDR_REGEX is required: wsproxy otherwise permits only
  // *.neon.tech:5432 and refuses a local backend with `allowed=false`.
  const proxy = docker([
    "run", "-d", "--name", PROXY, "--network", NETWORK,
    "-p", `${PROXY_PORT}:80`,
    "-e", `PG_CONNECTION_STRING=postgres://klh:klh@${DB}:5432/klh_canteen_test`,
    "-e", "ALLOW_ADDR_REGEX=.*",
    "ghcr.io/neondatabase/wsproxy:latest",
  ]);
  if (proxy.status !== 0) {
    console.error(proxy.stderr || "failed to start wsproxy");
    process.exit(1);
  }

  console.log(`
test database ready.

  postgres  localhost:${DB_PORT}   (klh_canteen_test)
  wsproxy   localhost:${PROXY_PORT}

Copy .env.test.example to .env.test if you have not already, then:

  npm test

Stop it again with:

  npm run test:db:down
`);
}

function down() {
  requireDocker();
  docker(["rm", "-f", PROXY]);
  docker(["rm", "-f", DB]);
  docker(["network", "rm", NETWORK]);
  console.log("test database removed.");
}

const command = process.argv[2];
if (command === "up") up();
else if (command === "down") down();
else {
  console.error("usage: node scripts/testDb.mjs <up|down>");
  process.exit(1);
}
