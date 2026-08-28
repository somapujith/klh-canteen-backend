/**
 * Raw-SQL data access for the "Category" table, replacing `prisma.category.*`
 * calls in src/services/menuService.ts. Every column of `Category` maps 1:1
 * to a struct field (see src/db/schema.ts), so functions here return the
 * full row rather than accepting Prisma-style `select` objects.
 *
 * `Runner` accepts a `Pool`, a `PoolClient`, or anything else shaped like
 * `QueryRunner` (src/db/sql.ts) — which includes lib/db.ts's HTTP `getHttpSql()`
 * client. Nothing here needs a transaction today, so read call sites are free
 * to pass either.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, joinSql, raw, query, type QueryRunner } from "./sql.js";
import type { SqlFragment } from "./sql.js";
import { assertAffected } from "./errors.js";
import { withTransaction } from "./tx.js";
import type { Category, Kitchen } from "./schema.js";

export type Runner = Pool | PoolClient | QueryRunner;

const ALL_COLUMNS = `"id", "name", "sortOrder", "kitchen", "isArchived"`;

export interface CategoryCreateInput {
  name: string;
  sortOrder: number;
  kitchen: Kitchen;
}

export interface CategoryUpdateInput {
  name?: string;
  sortOrder?: number;
}

/**
 * All categories, optionally scoped to one kitchen, ordered the same way
 * `prisma.category.findMany({ orderBy: { sortOrder: "asc" } })` was.
 */
export async function findCategories(runner: Runner, kitchen?: Kitchen): Promise<Category[]> {
  const kitchenFilter = kitchen ? sql`AND "kitchen" = ${kitchen}` : sql``;
  const { rows } = await query<Category>(
    runner,
    sql`
      SELECT ${raw(ALL_COLUMNS)} FROM "Category"
      WHERE "isArchived" = false ${kitchenFilter}
      ORDER BY "sortOrder" ASC
    `
  );
  return rows;
}

export async function findCategoryById(runner: Runner, id: string): Promise<Category | null> {
  const { rows } = await query<Category>(
    runner,
    sql`SELECT ${raw(ALL_COLUMNS)} FROM "Category" WHERE "id" = ${id} AND "isArchived" = false`
  );
  return rows[0] ?? null;
}

export async function insertCategory(runner: Runner, data: CategoryCreateInput): Promise<Category> {
  const { rows } = await query<Category>(
    runner,
    sql`
      INSERT INTO "Category" ("id", "name", "sortOrder", "kitchen")
      VALUES (${crypto.randomUUID()}, ${data.name}, ${data.sortOrder}, ${data.kitchen})
      RETURNING ${raw(ALL_COLUMNS)}
    `
  );
  return rows[0];
}

/**
 * Mirrors `prisma.category.update({ where: { id }, data })`: throws (via
 * assertAffected) if the row is gone by the time the UPDATE runs, the same
 * P2025-equivalent the caller already guards against with its own
 * pre-fetch. An empty `data` degenerates to a plain existence re-check,
 * matching Prisma's behaviour of a no-op update.
 */
export async function updateCategory(runner: Runner, id: string, data: CategoryUpdateInput): Promise<Category> {
  const sets: SqlFragment[] = [];
  if (data.name !== undefined) sets.push(sql`"name" = ${data.name}`);
  if (data.sortOrder !== undefined) sets.push(sql`"sortOrder" = ${data.sortOrder}`);

  if (sets.length === 0) {
    const existing = await findCategoryById(runner, id);
    assertAffected(existing ? 1 : 0, "Category not found");
    return existing as Category;
  }

  const { rows, rowCount } = await query<Category>(
    runner,
    sql`UPDATE "Category" SET ${joinSql(sets)} WHERE "id" = ${id} AND "isArchived" = false RETURNING ${raw(ALL_COLUMNS)}`
  );
  assertAffected(rowCount, "Category not found");
  return rows[0];
}

/**
 * Soft delete, cascading to the category's items — see Category.isArchived.
 *
 * Takes a Pool rather than a Runner because the two UPDATEs have to be one
 * transaction: archiving the category but not its items would leave those
 * items on the menu belonging to a category nobody can see, and archiving the
 * items but not the category would empty a category that is still listed.
 *
 * Returns how many items went with it, so the caller can report it.
 */
export async function archiveCategoryWithItems(pool: Pool, id: string): Promise<{ archivedItems: number }> {
  return withTransaction(pool, async (client) => {
    const { rowCount } = await query(
      client,
      sql`UPDATE "Category" SET "isArchived" = true WHERE "id" = ${id} AND "isArchived" = false`
    );
    assertAffected(rowCount, "Category not found");

    const { rowCount: archivedItems } = await query(
      client,
      sql`UPDATE "MenuItem" SET "isArchived" = true WHERE "categoryId" = ${id} AND "isArchived" = false`
    );
    return { archivedItems };
  });
}
