/**
 * Raw-SQL data access for the "StockRequest" table — students waiting on a
 * sold-out item, and the demand counts the admin restocks against.
 *
 * `Runner` accepts a `Pool`, a `PoolClient`, or anything else shaped like
 * `QueryRunner` (src/db/sql.ts), matching the convention in the sibling repos.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, query, type QueryRunner } from "./sql.js";
import type { School } from "./schema.js";

export type Runner = Pool | PoolClient | QueryRunner;

/** One item's outstanding demand, for the admin list. */
export interface StockRequestCount {
  menuItemId: string;
  menuItemName: string;
  kitchen: string;
  count: number;
  /** Oldest outstanding request, so the admin can see who has waited longest. */
  firstRequestedAt: Date;
}

/** A requester to notify. `telegramChatId` is null when they never linked. */
export interface StockRequester {
  studentId: string;
  name: string;
  telegramChatId: string | null;
}

/**
 * Records a request, idempotently. Returns true if this call created it and
 * false if the student had already asked — the caller uses that to decide
 * whether the admin needs a notification, since re-taps must not re-alert.
 *
 * ON CONFLICT rather than a check-then-insert: two taps racing on a double
 * click would both pass the check and one would blow up on the constraint.
 */
export async function createStockRequest(
  runner: Runner,
  menuItemId: string,
  studentId: string
): Promise<boolean> {
  const { rowCount } = await query(
    runner,
    sql`
      INSERT INTO "StockRequest" ("id", "menuItemId", "studentId")
      VALUES (${crypto.randomUUID()}, ${menuItemId}, ${studentId})
      ON CONFLICT ("menuItemId", "studentId") DO NOTHING
    `
  );
  return rowCount > 0;
}

/**
 * Outstanding demand per item, newest-demand-first.
 *
 * Joins User to keep the count to one school: requests are a KLH-only feature,
 * and counting a DRK student would put a number in front of a KLH admin that
 * they cannot act on. Archived items are excluded — nobody is restocking those.
 */
export async function findStockRequestCounts(
  runner: Runner,
  school: School,
  kitchen?: string
): Promise<StockRequestCount[]> {
  const kitchenFilter = kitchen ? sql`AND c."kitchen" = ${kitchen}` : sql``;
  const { rows } = await query<StockRequestCount>(
    runner,
    sql`
      SELECT sr."menuItemId"          AS "menuItemId",
             mi."name"                AS "menuItemName",
             c."kitchen"              AS "kitchen",
             count(*)::int            AS "count",
             min(sr."createdAt")      AS "firstRequestedAt"
        FROM "StockRequest" sr
        JOIN "MenuItem" mi ON mi."id" = sr."menuItemId"
        JOIN "Category" c  ON c."id"  = mi."categoryId"
        JOIN "User" u      ON u."id"  = sr."studentId"
       WHERE u."school" = ${school}::"School"
         AND mi."isArchived" = false
         ${kitchenFilter}
       GROUP BY sr."menuItemId", mi."name", c."kitchen"
       ORDER BY count(*) DESC, min(sr."createdAt") ASC
    `
  );
  return rows;
}

/** How many students are waiting on one item, for the realtime delta. */
export async function countStockRequestsForItem(
  runner: Runner,
  menuItemId: string,
  school: School
): Promise<number> {
  const { rows } = await query<{ count: number }>(
    runner,
    sql`
      SELECT count(*)::int AS "count"
        FROM "StockRequest" sr
        JOIN "User" u ON u."id" = sr."studentId"
       WHERE sr."menuItemId" = ${menuItemId} AND u."school" = ${school}::"School"
    `
  );
  return rows[0]?.count ?? 0;
}

/**
 * Who to message when one item comes back. Returns everyone waiting,
 * including students with no linked Telegram — the caller reports how many
 * were actually reachable rather than quietly overstating the send.
 */
export async function findRequestersForItem(
  runner: Runner,
  menuItemId: string,
  school: School
): Promise<StockRequester[]> {
  const { rows } = await query<StockRequester>(
    runner,
    sql`
      SELECT u."id" AS "studentId", u."name" AS "name", u."telegramChatId" AS "telegramChatId"
        FROM "StockRequest" sr
        JOIN "User" u ON u."id" = sr."studentId"
       WHERE sr."menuItemId" = ${menuItemId} AND u."school" = ${school}::"School"
    `
  );
  return rows;
}

/**
 * Clears one item's requests once the restock notification has gone out — the
 * round is over, and demand for the next sell-out starts from zero.
 */
export async function clearStockRequestsForItem(
  runner: Runner,
  menuItemId: string,
  school: School
): Promise<number> {
  const { rowCount } = await query(
    runner,
    sql`
      DELETE FROM "StockRequest" sr
       USING "User" u
       WHERE u."id" = sr."studentId"
         AND sr."menuItemId" = ${menuItemId}
         AND u."school" = ${school}::"School"
    `
  );
  return rowCount;
}
