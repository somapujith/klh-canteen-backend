/**
 * Raw-SQL data access for the "Category" table, replacing `prisma.category.*`
 * calls in src/services/menuService.ts. Every column of `Category` maps 1:1
 * to a struct field (see src/db/schema.ts), so functions here return the
 * full row rather than accepting Prisma-style `select` objects.
 *
 * `Runner` accepts a `Pool` or a `PoolClient` — nothing here needs a
 * transaction today, but the wider union matches src/db/sql.ts's
 * `QueryRunner` shape and userRepo.ts's convention.
 */
import crypto from "node:crypto";
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, joinSql, raw, query } from "./sql.js";
import type { SqlFragment } from "./sql.js";
import { assertAffected } from "./errors.js";
import type { Category, Kitchen } from "./schema.js";

export type Runner = Pool | PoolClient;

const ALL_COLUMNS = `"id", "name", "sortOrder", "kitchen"`;

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
  const where = kitchen ? sql`WHERE "kitchen" = ${kitchen}` : sql``;
  const { rows } = await query<Category>(
    runner,
    sql`SELECT ${raw(ALL_COLUMNS)} FROM "Category" ${where} ORDER BY "sortOrder" ASC`
  );
  return rows;
}

export async function findCategoryById(runner: Runner, id: string): Promise<Category | null> {
  const { rows } = await query<Category>(
    runner,
    sql`SELECT ${raw(ALL_COLUMNS)} FROM "Category" WHERE "id" = ${id}`
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
    sql`UPDATE "Category" SET ${joinSql(sets)} WHERE "id" = ${id} RETURNING ${raw(ALL_COLUMNS)}`
  );
  assertAffected(rowCount, "Category not found");
  return rows[0];
}

export async function deleteCategory(runner: Runner, id: string): Promise<void> {
  const { rowCount } = await query(runner, sql`DELETE FROM "Category" WHERE "id" = ${id}`);
  assertAffected(rowCount, "Category not found");
}
