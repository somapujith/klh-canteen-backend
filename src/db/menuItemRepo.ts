/**
 * Raw-SQL data access for the "MenuItem" table, replacing `prisma.menuItem.*`
 * calls in src/services/menuService.ts.
 *
 * `Runner` accepts a `Pool`, a `PoolClient`, or anything else shaped like
 * `QueryRunner` (src/db/sql.ts) — which includes lib/db.ts's HTTP `getHttpSql()`
 * client. Nothing here needs a transaction today, matching categoryRepo.ts /
 * userRepo.ts's convention.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, joinSql, raw, query, type QueryRunner } from "./sql.js";
import type { SqlFragment } from "./sql.js";
import { assertAffected } from "./errors.js";
import type { Kitchen, MenuItem } from "./schema.js";

export type Runner = Pool | PoolClient | QueryRunner;

const ALL_COLUMNS = `
  "id", "name", "imageUrl", "imageHash", "price", "stockQty", "reservedQty", "isAvailable", "isArchived", "categoryId", "sortOrder"
`;

export interface MenuItemCreateInput {
  name: string;
  imageUrl?: string | null;
  price: string;
  stockQty: number;
  categoryId: string;
  sortOrder?: number;
}

export interface MenuItemUpdateInput {
  name?: string;
  imageUrl?: string | null;
  price?: string;
  stockQty?: number;
  isAvailable?: boolean;
  categoryId?: string;
  sortOrder?: number;
}

/**
 * Items for a set of categories, matching the two projections
 * `getCategorizedMenu` (menuService.ts) needs: the admin view (all items)
 * and the customer view (`isAvailable = true` only). Empty `categoryIds`
 * short-circuits rather than issuing a query that would just return zero
 * rows — the caller (an empty menu) hits this on a fresh/empty kitchen.
 *
 * Archived items are excluded from BOTH projections: unlike `isAvailable`,
 * which the admin view deliberately shows so a sold-out item can be toggled
 * back on, archival is terminal and the item is gone from the inventory list.
 */
export async function findMenuItemsByCategoryIds(
  runner: Runner,
  categoryIds: string[],
  opts: { availableOnly?: boolean } = {}
): Promise<MenuItem[]> {
  if (categoryIds.length === 0) return [];
  const availableFilter = opts.availableOnly ? sql`AND "isAvailable" = true` : sql``;
  const { rows } = await query<MenuItem>(
    runner,
    sql`
      SELECT ${raw(ALL_COLUMNS)} FROM "MenuItem"
      WHERE "categoryId" = ANY(${categoryIds}) AND "isArchived" = false ${availableFilter}
      ORDER BY "sortOrder" ASC, "id" ASC
    `
  );
  return rows;
}

export async function findMenuItemById(runner: Runner, id: string): Promise<MenuItem | null> {
  const { rows } = await query<MenuItem>(
    runner,
    sql`SELECT ${raw(ALL_COLUMNS)} FROM "MenuItem" WHERE "id" = ${id} AND "isArchived" = false`
  );
  return rows[0] ?? null;
}

/**
 * Replaces `prisma.menuItem.findUnique({ where: { id }, include: { category:
 * true } })` as used before update/delete to check kitchen ownership — the
 * caller only ever reads `category.kitchen` off the result, so this returns
 * just that instead of the full joined Category row.
 */
export async function findMenuItemWithCategoryKitchen(
  runner: Runner,
  id: string
): Promise<{ item: MenuItem; categoryKitchen: Kitchen } | null> {
  const { rows } = await query<MenuItem & { categoryKitchen: Kitchen }>(
    runner,
    sql`
      SELECT mi."id", mi."name", mi."imageUrl", mi."imageHash", mi."price", mi."stockQty", mi."reservedQty",
             mi."isAvailable", mi."isArchived", mi."categoryId", c."kitchen" AS "categoryKitchen"
      FROM "MenuItem" mi
      JOIN "Category" c ON c."id" = mi."categoryId"
      WHERE mi."id" = ${id} AND mi."isArchived" = false
    `
  );
  const row = rows[0];
  if (!row) return null;
  const { categoryKitchen, ...item } = row;
  return { item, categoryKitchen };
}

export async function insertMenuItem(runner: Runner, data: MenuItemCreateInput): Promise<MenuItem> {
  const { rows } = await query<MenuItem>(
    runner,
    sql`
      INSERT INTO "MenuItem" ("id", "name", "imageUrl", "price", "stockQty", "categoryId", "sortOrder")
      VALUES (${crypto.randomUUID()}, ${data.name}, ${data.imageUrl}, ${data.price}, ${data.stockQty}, ${data.categoryId}, ${data.sortOrder ?? 0})
      RETURNING ${raw(ALL_COLUMNS)}
    `
  );
  return rows[0];
}

/** Mirrors `prisma.menuItem.update({ where: { id }, data })`. */
export async function updateMenuItem(runner: Runner, id: string, data: MenuItemUpdateInput): Promise<MenuItem> {
  const sets: SqlFragment[] = [];
  if (data.name !== undefined) sets.push(sql`"name" = ${data.name}`);
  if (data.imageUrl !== undefined) sets.push(sql`"imageUrl" = ${data.imageUrl}`);
  if (data.price !== undefined) sets.push(sql`"price" = ${data.price}`);
  if (data.stockQty !== undefined) sets.push(sql`"stockQty" = ${data.stockQty}`);
  if (data.isAvailable !== undefined) sets.push(sql`"isAvailable" = ${data.isAvailable}`);
  if (data.categoryId !== undefined) sets.push(sql`"categoryId" = ${data.categoryId}`);
  if (data.sortOrder !== undefined) sets.push(sql`"sortOrder" = ${data.sortOrder}`);

  if (sets.length === 0) {
    const existing = await findMenuItemById(runner, id);
    assertAffected(existing ? 1 : 0, "Menu item not found");
    return existing as MenuItem;
  }

  const { rows, rowCount } = await query<MenuItem>(
    runner,
    sql`UPDATE "MenuItem" SET ${joinSql(sets)} WHERE "id" = ${id} RETURNING ${raw(ALL_COLUMNS)}`
  );
  assertAffected(rowCount, "Menu item not found");
  return rows[0];
}

/**
 * Soft delete — see MenuItem.isArchived in schema.ts for why this cannot be a
 * real DELETE. Already-archived rows are filtered out by the WHERE clause, so
 * a second archive of the same id affects zero rows and 404s exactly as
 * deleting an already-deleted item did before.
 */
export async function archiveMenuItem(runner: Runner, id: string): Promise<void> {
  const { rowCount } = await query(
    runner,
    sql`UPDATE "MenuItem" SET "isArchived" = true WHERE "id" = ${id} AND "isArchived" = false`
  );
  assertAffected(rowCount, "Menu item not found");
}

/**
 * Mirrors `prisma.menuItem.updateMany({ where: { categoryId }, data })` —
 * category-scoped bulk toggle (availability and/or stock) used by
 * bulkUpdateCategoryItems. Unlike the single-row update above, zero matching
 * rows is not an error: an empty category is a valid (if unusual) target.
 */
export async function updateMenuItemsByCategory(
  runner: Runner,
  categoryId: string,
  data: { isAvailable?: boolean; stockQty?: number }
): Promise<number> {
  const sets: SqlFragment[] = [];
  if (data.isAvailable !== undefined) sets.push(sql`"isAvailable" = ${data.isAvailable}`);
  if (data.stockQty !== undefined) sets.push(sql`"stockQty" = ${data.stockQty}`);
  if (sets.length === 0) return 0;

  const { rowCount } = await query(
    runner,
    sql`UPDATE "MenuItem" SET ${joinSql(sets)} WHERE "categoryId" = ${categoryId} AND "isArchived" = false`
  );
  return rowCount;
}
