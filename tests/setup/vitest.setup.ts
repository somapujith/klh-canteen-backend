/**
 * Per-test-file setup. vitest imports this before the test module is
 * evaluated, which means it runs before `beforeAll`/`beforeEach` are even
 * registered — the guard cannot be outrun by a hook.
 *
 * If any check here throws, the whole file fails immediately and no cleanup
 * hook ever executes.
 */
import { resolveTestEnv } from "./testEnv.js";
import { verifyTestDatabaseMarker } from "./marker.js";
import { markGuardVerified } from "./guardState.js";

const env = resolveTestEnv();

if (env.hasDatabase) {
  await verifyTestDatabaseMarker(env.databaseUrl!);
  markGuardVerified();
}
