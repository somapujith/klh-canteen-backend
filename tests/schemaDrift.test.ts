import { describe, it, expect, inject } from "vitest";
import { testDb } from "./helpers/db.js";

/**
 * Can this database be rebuilt from `prisma/migrations` alone?
 *
 * The bootstrap runs `prisma migrate deploy` on a brand-new database and then
 * asks `prisma migrate diff` what is still missing compared to
 * prisma/schema.prisma. Anything it reports is schema that exists only because
 * somebody ran `db push` against a live database: it is in the running
 * database and in the Prisma schema, but in no migration. A restore from
 * migrations — a new environment, a disaster recovery, a fresh Neon branch —
 * silently comes up with the wrong schema.
 *
 * This test fails while that is true. It is not testing the test harness; it
 * is testing the repository's ability to reproduce its own database.
 */
describe("migrations reproduce prisma/schema.prisma", () => {
  it("has no drift between the migration history and the Prisma schema", () => {
    if (!testDb.enabled) return;
    const drift = inject("schemaDrift");
    expect(drift, `migrations are missing this schema:\n${drift}`).toBeNull();
  });
});
