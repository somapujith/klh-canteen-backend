/**
 * Per-worker record of whether the guard signed off. tests/helpers/db.ts
 * refuses to hand out a PrismaClient or wipe anything until this is true, so
 * a test file that somehow ran without the setup file cannot reach the
 * database at all.
 */
let verified = false;
let reason = "the database guard has not run";

export function markGuardVerified(): void {
  verified = true;
  reason = "";
}

export function isGuardVerified(): boolean {
  return verified;
}

export function assertGuardVerified(): void {
  if (!verified) {
    throw new Error(
      `REFUSING database access from a test: ${reason}. ` +
        "tests/setup/vitest.setup.ts must run first — check vitest.config.ts setupFiles.",
    );
  }
}
