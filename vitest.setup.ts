/**
 * DEPRECATED — and deliberately loud about it.
 *
 * This file used to be vitest's only setup step, and all it did was
 * `import "dotenv/config"`, which loads `.env` — the file pointing at the
 * SHARED LIVE Neon database. Combined with the suite's `deleteMany()` cleanup
 * hooks, that is what destroyed real accounts and the entire menu.
 *
 * The real setup now lives in tests/setup/ and is wired up in vitest.config.ts.
 * If anything still imports this file, that is a misconfiguration worth
 * failing on rather than quietly restoring the old behaviour.
 */
throw new Error(
  "vitest.setup.ts is obsolete and MUST NOT be used: it loaded .env (the live database). " +
    "Use tests/setup/vitest.setup.ts — see vitest.config.ts and TESTING.md.",
);
