import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import {
  countExportRows,
  exportDateStamp,
  resolveExportWindow,
  streamOrdersCsv,
  MAX_EXPORT_WINDOW_DAYS,
} from "../services/orderExportService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool } from "../lib/context.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { AppEnv } from "../types.js";

/**
 * Reconciliation exports, mounted at /superadmin/exports.
 *
 *   GET /superadmin/exports/orders.csv?from=&to=&kitchen=&status=
 *
 * Returns a streamed text/csv download of every order in the window with its
 * customer — student or walk-up guest — totals, status and timestamps. The
 * window defaults to the last 30 days and is capped at MAX_EXPORT_WINDOW_DAYS;
 * a full year is exported as consecutive requests rather than as one query
 * that scans the table.
 */
export const superAdminExportsRouter = new Hono<AppEnv>();

superAdminExportsRouter.use("*", requireAuth("SUPERADMIN"));

const ORDER_STATUSES = ["PENDING", "PREPARING", "COOKED", "DELIVERED"] as const;

const exportQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  kitchen: z.enum(["SNACKS", "MEALS"]).optional(),
  status: z.string().min(1).optional(),
});

superAdminExportsRouter.get("/orders.csv", async (c) => {
  const query = exportQuerySchema.parse({
    from: c.req.query("from"),
    to: c.req.query("to"),
    kitchen: c.req.query("kitchen"),
    status: c.req.query("status"),
  });

  const statuses = query.status
    ? query.status
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is (typeof ORDER_STATUSES)[number] =>
          (ORDER_STATUSES as readonly string[]).includes(s),
        )
    : undefined;

  if (query.status && (!statuses || statuses.length === 0)) {
    throw new ApiError(400, "INVALID_STATUS", `status must be one or more of ${ORDER_STATUSES.join(", ")}`);
  }

  const options = { kitchen: query.kitchen, statuses };
  const window = resolveExportWindow({
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  });

  const pool = getRequestPool(c);
  const actor = c.get("user")!;

  // Counted and logged BEFORE the stream starts. Once the response headers are
  // written the handler has already returned, and on Workers any work started
  // after that needs waitUntil to survive — an audit entry for a data export
  // is not something to leave to chance.
  const rowCount = await countExportRows(pool, window, options);
  await logAction(pool, actor.id, "ORDER_EXPORT", "Order", undefined, {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    kitchen: query.kitchen ?? null,
    statuses: statuses ?? null,
    rowCount,
  });

  const filename = `orders_${exportDateStamp(window.from)}_to_${exportDateStamp(window.to)}.csv`;

  return new Response(streamOrdersCsv(pool, window, options), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // The body is produced lazily, so its length is not known up front.
      "Cache-Control": "no-store",
      "X-Row-Count": String(rowCount),
      "X-Export-From": window.from.toISOString(),
      "X-Export-To": window.to.toISOString(),
      "X-Max-Window-Days": String(MAX_EXPORT_WINDOW_DAYS),
      "Access-Control-Expose-Headers":
        "Content-Disposition, X-Row-Count, X-Export-From, X-Export-To, X-Max-Window-Days",
    },
  });
});
