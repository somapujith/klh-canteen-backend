/**
 * Raw-SQL data access for the "MenuItemImage" table.
 *
 * `MenuItem.imageHash IS NOT NULL` must always mean a matching row exists
 * here — both writes below keep that invariant by updating both tables in
 * one transaction. No other module may write `imageHash` directly.
 *
 * Both `putImage` and `deleteImage` take a `FOR UPDATE` row lock on the
 * PARENT "MenuItem" row FIRST, inside the same transaction, before touching
 * "MenuItemImage". This closes two races structurally, with one mechanism:
 *
 *  - When no "MenuItemImage" row exists yet, a DELETE that matches zero rows
 *    takes no lock of its own, so a concurrent putImage could previously
 *    interleave between the DELETE and the following `imageHash = NULL`
 *    UPDATE — leaving real bytes in "MenuItemImage" but "MenuItem".imageHash
 *    left NULL (uploaded but permanently invisible). Locking "MenuItem"
 *    first makes every concurrent put/delete on the same item serialize on
 *    that row regardless of whether a "MenuItemImage" row currently exists.
 *  - The lock query doubles as a fresh, in-transaction existence check: if
 *    the item was deleted by a concurrent request between the caller's
 *    earlier existence check and this write (a real window — a SHA-256 hash
 *    computation over up to 512KB sits in between in
 *    menuImageService.uploadMenuItemImage), zero rows come back here and we
 *    throw a clean 404 instead of letting the INSERT's FK violation escape
 *    as a raw, unhandled Postgres 23503 (which surfaces as a 500).
 *
 * Throwing ApiError directly from inside a repo function (via
 * assertAffected, src/db/errors.ts) mirrors the existing convention in
 * menuItemRepo.ts's updateMenuItem/deleteMenuItem — this file follows the
 * same layering the rest of the codebase already tolerates rather than
 * inventing a new "not found inside a transaction" signal.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { withTransaction } from "./tx.js";
import { sql, query } from "./sql.js";
import { assertAffected } from "./errors.js";
import type { MenuItemImage } from "./schema.js";

export type Runner = Pool | PoolClient;

export interface PutImageInput {
  menuItemId: string;
  bytes: Uint8Array;
  mimeType: "image/webp" | "image/jpeg";
  hash: string;
  width: number;
  height: number;
  uploadedById: string;
}

/** Locks the parent "MenuItem" row and 404s if it no longer exists. Must be the first statement in the transaction. */
async function lockMenuItemOrThrow(client: PoolClient, menuItemId: string): Promise<void> {
  const { rowCount } = await query(client, sql`SELECT "id" FROM "MenuItem" WHERE "id" = ${menuItemId} FOR UPDATE`);
  assertAffected(rowCount, "Menu item not found");
}

/**
 * Replaces this item's image (upsert) and stamps the new hash onto
 * "MenuItem" in the same transaction, so a reader never observes a hash with
 * no matching bytes or bytes with a stale hash.
 */
export async function putImage(pool: Pool, input: PutImageInput): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockMenuItemOrThrow(client, input.menuItemId);

    await query(
      client,
      sql`
        INSERT INTO "MenuItemImage"
          ("menuItemId", "bytes", "mimeType", "byteSize", "width", "height", "uploadedById")
        VALUES (${input.menuItemId}, ${input.bytes}, ${input.mimeType}, ${input.bytes.byteLength}, ${input.width}, ${input.height}, ${input.uploadedById})
        ON CONFLICT ("menuItemId") DO UPDATE SET
          "bytes" = EXCLUDED."bytes",
          "mimeType" = EXCLUDED."mimeType",
          "byteSize" = EXCLUDED."byteSize",
          "width" = EXCLUDED."width",
          "height" = EXCLUDED."height",
          "uploadedById" = EXCLUDED."uploadedById",
          "createdAt" = now()
      `
    );
    await query(client, sql`UPDATE "MenuItem" SET "imageHash" = ${input.hash} WHERE "id" = ${input.menuItemId}`);
  });
}

/** Removes this item's image and clears its hash, in one transaction. */
export async function deleteImage(pool: Pool, menuItemId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockMenuItemOrThrow(client, menuItemId);

    await query(client, sql`DELETE FROM "MenuItemImage" WHERE "menuItemId" = ${menuItemId}`);
    await query(client, sql`UPDATE "MenuItem" SET "imageHash" = NULL WHERE "id" = ${menuItemId}`);
  });
}

export async function findImage(runner: Runner, menuItemId: string): Promise<MenuItemImage | null> {
  const { rows } = await query<MenuItemImage>(
    runner,
    sql`
      SELECT "menuItemId", "bytes", "mimeType", "byteSize", "width", "height", "uploadedById", "createdAt"
      FROM "MenuItemImage" WHERE "menuItemId" = ${menuItemId}
    `
  );
  return rows[0] ?? null;
}
