import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * globalSetup runs once in the main process, BEFORE any worker exists:
     * it validates the database target, applies migrations and claims the
     * database with the guard marker. setupFiles then runs inside every
     * worker, before each test module is evaluated — i.e. before a single
     * beforeAll/beforeEach is even registered — and re-verifies the target.
     *
     * Both are required. Neither loads `.env`. See tests/setup/databaseGuard.ts
     * and TESTING.md.
     */
    globalSetup: ["./tests/setup/globalSetup.ts"],
    setupFiles: ["./tests/setup/vitest.setup.ts"],

    // Test files share one Postgres database and wipe it between tests, so
    // running files concurrently races one file's cleanup against another's
    // assertions. Sequential until the suite gets schema-per-worker isolation.
    fileParallelism: false,

    // bcrypt hashing plus a cold Postgres connection makes the first hook in a
    // file slower than vitest's 10s default.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
