import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Test files share one Postgres DB and each does full-table deleteMany()
    // in beforeEach. Running files in parallel races that cleanup against
    // other files' creates/assertions (unique constraint violations, flaky
    // empty results). Force sequential file execution until tests get
    // proper per-file isolation (e.g. schema-per-worker or transactions).
    fileParallelism: false,
  },
});
