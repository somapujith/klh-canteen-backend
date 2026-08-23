import { describe, it, expect } from "vitest";
import {
  assertSafeTestDatabaseUrl,
  readLiveDatabaseUrls,
  TestDatabaseGuardError,
} from "./setup/databaseGuard.js";
import { testDb } from "./helpers/db.js";

/**
 * These are the regression tests for the incident: `npm test` was run with
 * `.env` in place, the suite's cleanup hooks pointed at the shared live Neon
 * database, and three admin accounts, a student and the entire menu were
 * deleted.
 *
 * Every case below fails if the guard is weakened. The first one reads the
 * ACTUAL live connection string out of the repo's `.env` and asserts the guard
 * refuses it — so it keeps protecting whatever `.env` points at in future,
 * not just the URL that was there when this was written.
 */
describe("test database guard", () => {
  const LOCAL = "postgresql://klh_test:klh_test@localhost:55433/klh_canteen_test";

  describe("the incident: the live database must be refused", () => {
    const liveUrls = readLiveDatabaseUrls();

    it("finds a DATABASE_URL in .env to protect against", () => {
      // If this ever fails, the check below has nothing to prove and the rest
      // of the suite is running without its most important guarantee.
      expect(liveUrls.length).toBeGreaterThan(0);
    });

    it.each(liveUrls.map((url, i) => [i, url] as const))(
      "refuses live URL #%i from .env even with every opt-in switched on",
      (_i, liveUrl) => {
        expect(() =>
          assertSafeTestDatabaseUrl(liveUrl, { allowRemote: true }),
        ).toThrow(TestDatabaseGuardError);
      },
    );

    it("names the live database in the refusal so a tired engineer sees why", () => {
      expect(() => assertSafeTestDatabaseUrl(liveUrls[0], { allowRemote: true })).toThrow(
        /REFUSING TO RUN TESTS/,
      );
    });

    it("refuses a live URL even when the credentials are changed (it compares host+port+database)", () => {
      const disguised = liveUrls[0]!.replace(/:\/\/[^:]+:[^@]+@/, "://someone_else:hunter2@");
      expect(() => assertSafeTestDatabaseUrl(disguised, { allowRemote: true })).toThrow(
        /SAME DATABASE that \.env points at/,
      );
    });
  });

  describe("static rules", () => {
    it("accepts the local docker test database", () => {
      const target = assertSafeTestDatabaseUrl(LOCAL);
      expect(target.host).toBe("localhost");
      expect(target.database).toBe("klh_canteen_test");
      expect(target.isLocal).toBe(true);
    });

    it("refuses a local database whose name does not say it is a test database", () => {
      expect(() =>
        assertSafeTestDatabaseUrl("postgresql://klh:klh@localhost:5433/klh_canteen"),
      ).toThrow(/does not contain "test"/);
    });

    it('refuses "neondb" — the live database name — outright', () => {
      expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@localhost:5432/neondb")).toThrow(
        /does not contain "test"/,
      );
    });

    it("refuses a remote host without the explicit ALLOW_REMOTE_TEST_DATABASE opt-in", () => {
      expect(() =>
        assertSafeTestDatabaseUrl(
          "postgresql://u:p@ep-some-branch.ap-southeast-1.aws.neon.tech/klh_test",
        ),
      ).toThrow(/is not a local or CI host/);
    });

    it("allows a dedicated remote Neon branch only when the opt-in is set", () => {
      const target = assertSafeTestDatabaseUrl(
        "postgresql://u:p@ep-some-branch.ap-southeast-1.aws.neon.tech/klh_test",
        { allowRemote: true, liveUrls: [] },
      );
      expect(target.isLocal).toBe(false);
      expect(target.database).toBe("klh_test");
    });

    it("refuses an unset DATABASE_URL rather than defaulting to anything", () => {
      expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
      expect(() => assertSafeTestDatabaseUrl("   ")).toThrow(/DATABASE_URL is not set/);
    });

    it("refuses a non-postgres URL", () => {
      expect(() => assertSafeTestDatabaseUrl("mysql://u:p@localhost:3306/klh_test")).toThrow(
        /expected postgresql:/,
      );
      expect(() => assertSafeTestDatabaseUrl("not a url at all")).toThrow(/not a parseable URL/);
    });

    it("never prints the password of the database it refused", () => {
      let message = "";
      try {
        assertSafeTestDatabaseUrl("postgresql://user:sup3rs3cret@localhost:5432/prod");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain("sup3rs3cret");
      expect(message).toContain("********");
    });
  });

  describe("what the suite actually connected to", () => {
    /**
     * Vitest (via Vite) injects `.env.test` into process.env by itself, and
     * can be configured to load more files. This is the backstop: whatever any
     * loader put there, the variable the APP reads at test time must never be
     * the live one. tests/setup/testEnv.ts deletes any inherited value before
     * anything can use it.
     */
    it("never leaves the live DATABASE_URL in process.env for the app to pick up", () => {
      for (const liveUrl of readLiveDatabaseUrls()) {
        expect(process.env.DATABASE_URL).not.toBe(liveUrl);
      }
    });

    it("is never the database named in .env", () => {
      if (!testDb.enabled) return;
      const live = readLiveDatabaseUrls();
      for (const liveUrl of live) {
        expect(testDb.url).not.toBe(liveUrl);
      }
      // And it survives its own guard, with the real ambient opt-in state.
      expect(() =>
        assertSafeTestDatabaseUrl(testDb.url, {
          allowRemote: process.env.ALLOW_REMOTE_TEST_DATABASE === "1",
        }),
      ).not.toThrow();
    });
  });
});
