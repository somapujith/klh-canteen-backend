/**
 * "Tell me when it's back" — students registering interest in a sold-out item,
 * and the admin notifying them when it returns.
 *
 * KLH ONLY. The feature is scoped to one institution, and that scope is
 * enforced here on both sides rather than by hiding a button: requestItem
 * refuses a non-KLH student, and every read and notify path filters on
 * school. A DRK student calling the endpoint directly gets nothing.
 */
import type { Pool } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import * as stockRequestRepo from "../db/stockRequestRepo.js";
import * as userRepo from "../db/userRepo.js";
import { query, sql } from "../db/sql.js";
import { sendTelegramMessage, type TelegramEnv } from "./telegramService.js";
import type { Kitchen, School } from "../db/schema.js";

/** The one institution this feature is enabled for. */
export const STOCK_REQUEST_SCHOOL: School = "KLH";

export interface RequestItemResult {
  /** False when the student had already asked — the admin is not re-alerted. */
  created: boolean;
  /** Outstanding requests for the item after this call. */
  count: number;
  menuItemName: string;
  kitchen: Kitchen;
}

/**
 * Registers a student's interest in a sold-out item.
 *
 * Requestable means genuinely out of stock — `stockQty - reservedQty <= 0`,
 * the same figure the customer menu shows as available (see
 * getCategorizedMenu). An item the admin has merely hidden is NOT requestable:
 * hiding is how they take something off the menu deliberately, and inviting
 * requests for it would generate demand they have no intention of filling.
 */
export async function requestItem(
  pool: Pool,
  menuItemId: string,
  studentId: string
): Promise<RequestItemResult> {
  const student = await userRepo.findById(pool, studentId);
  if (!student || student.role !== "STUDENT") {
    throw new ApiError(403, "FORBIDDEN", "Only students can request items.");
  }
  if (student.school !== STOCK_REQUEST_SCHOOL) {
    throw new ApiError(403, "NOT_AVAILABLE", "Item requests are not available for your school.");
  }

  const { rows } = await query<{
    name: string;
    kitchen: Kitchen;
    available: number;
    isAvailable: boolean;
  }>(
    pool,
    sql`
      SELECT mi."name" AS "name",
             c."kitchen" AS "kitchen",
             (mi."stockQty" - mi."reservedQty") AS "available",
             mi."isAvailable" AS "isAvailable"
        FROM "MenuItem" mi
        JOIN "Category" c ON c."id" = mi."categoryId"
       WHERE mi."id" = ${menuItemId} AND mi."isArchived" = false
    `
  );
  const item = rows[0];
  if (!item) throw new ApiError(404, "NOT_FOUND", "Menu item not found");

  if (!item.isAvailable) {
    throw new ApiError(409, "NOT_REQUESTABLE", "This item is not on the menu right now.");
  }
  if (item.available > 0) {
    throw new ApiError(409, "IN_STOCK", "This item is in stock — you can order it now.");
  }

  const created = await stockRequestRepo.createStockRequest(pool, menuItemId, studentId);
  const count = await stockRequestRepo.countStockRequestsForItem(
    pool,
    menuItemId,
    STOCK_REQUEST_SCHOOL
  );

  return { created, count, menuItemName: item.name, kitchen: item.kitchen };
}

/** Outstanding demand, for the admin list. Kitchen-scoped for kitchen admins. */
export async function listStockRequests(pool: Pool, kitchen?: string | null) {
  return stockRequestRepo.findStockRequestCounts(pool, STOCK_REQUEST_SCHOOL, kitchen || undefined);
}

export interface NotifyResult {
  /** Requests cleared — the round is over regardless of reachability. */
  cleared: number;
  /** Students an actual Telegram message reached. */
  notified: number;
  /** Waiting students with no linked Telegram, so nothing could be sent. */
  unreachable: number;
  menuItemName: string;
}

/**
 * Tells everyone waiting that an item is back, then clears the round.
 *
 * Requests are cleared even for students with no Telegram link. Keeping them
 * would leave a count the admin can never discharge — the button would say
 * "5 waiting" forever with nobody left to message. Reachability is reported
 * instead, so the admin sees that 2 of 5 could not be reached rather than
 * being told 5 were notified.
 *
 * Sends are sequential and individually guarded: one student who blocked the
 * bot must not abort the notification for everyone behind them in the list.
 */
export async function notifyRestocked(
  pool: Pool,
  env: TelegramEnv,
  menuItemId: string,
  adminKitchen?: string | null
): Promise<NotifyResult> {
  const { rows } = await query<{ name: string; kitchen: Kitchen }>(
    pool,
    sql`
      SELECT mi."name" AS "name", c."kitchen" AS "kitchen"
        FROM "MenuItem" mi
        JOIN "Category" c ON c."id" = mi."categoryId"
       WHERE mi."id" = ${menuItemId} AND mi."isArchived" = false
    `
  );
  const item = rows[0];
  if (!item) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && item.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to notify for this item.");
  }

  const requesters = await stockRequestRepo.findRequestersForItem(
    pool,
    menuItemId,
    STOCK_REQUEST_SCHOOL
  );
  if (requesters.length === 0) {
    throw new ApiError(409, "NO_REQUESTS", "Nobody is waiting on this item.");
  }

  const reachable = requesters.filter((r) => r.telegramChatId);
  let notified = 0;

  if (env.TELEGRAM_BOT_TOKEN?.trim()) {
    const message = `${item.name} is back in stock — order it now before it runs out again.`;
    for (const requester of reachable) {
      try {
        // Returns false on a rejected send (blocked bot, stale chat id) rather
        // than throwing, so count the result — not the attempt.
        if (await sendTelegramMessage(env, requester.telegramChatId!, message)) notified++;
      } catch (err) {
        console.error("Restock notification failed", { studentId: requester.studentId, err });
      }
    }
  }

  const cleared = await stockRequestRepo.clearStockRequestsForItem(
    pool,
    menuItemId,
    STOCK_REQUEST_SCHOOL
  );

  return {
    cleared,
    notified,
    unreachable: requesters.length - reachable.length,
    menuItemName: item.name,
  };
}
