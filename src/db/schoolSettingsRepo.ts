/**
 * Raw-SQL data access for the "SchoolSettings" table — the superadmin-editable
 * platform fee %, one row per school. Mirrors categoryRepo.ts's shape: a
 * `Runner` accepts a Pool, a PoolClient, or anything QueryRunner-shaped.
 *
 * No row for a school means 0% — a missing row is the safe default, not an
 * error, so getPlatformFeePercent() never throws for an unset school.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, query, type QueryRunner } from "./sql.js";
import type { School } from "./schema.js";

export type Runner = Pool | PoolClient | QueryRunner;

/**
 * Current platform fee %, or 0 if the superadmin has never set one for this
 * school. `platformFeePercent` comes back as a string from the raw driver
 * (NUMERIC), same convention as every other Decimal column in schema.ts —
 * cast to Number here since the caller does fee math with it.
 */
export async function getPlatformFeePercent(runner: Runner, school: School): Promise<number> {
  const { rows } = await query<{ platformFeePercent: string }>(
    runner,
    sql`SELECT "platformFeePercent"::text AS "platformFeePercent" FROM "SchoolSettings" WHERE "school" = ${school}::"School"`
  );
  return rows[0] ? Number(rows[0].platformFeePercent) : 0;
}

/**
 * Upserts a school's fee %, same `ON CONFLICT ... DO UPDATE` idiom as
 * claimWindowSeats() in orderService.ts. `school` is the table's primary key,
 * so this is a plain single-row upsert — no WHERE guard needed the way a
 * capacity-ceiling upsert needs one.
 */
export async function setPlatformFeePercent(runner: Runner, school: School, percent: number): Promise<void> {
  await query(
    runner,
    sql`
    INSERT INTO "SchoolSettings" ("school", "platformFeePercent", "updatedAt")
    VALUES (${school}::"School", ${percent}::numeric(5, 2), NOW())
    ON CONFLICT ("school") DO UPDATE
       SET "platformFeePercent" = ${percent}::numeric(5, 2),
           "updatedAt" = NOW()
  `
  );
}
