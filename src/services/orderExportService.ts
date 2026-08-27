import type { Pool } from "@neondatabase/serverless";
import { sql, query } from "../db/sql.js";
import { WhereBuilder } from "../db/where.js";
import { ApiError } from "../middleware/errorHandler.js";
import { withCustomer } from "./orderService.js";

/**
 * Dated CSV export of orders for the canteen's own reconciliation.
 *
 * STREAMED, NOT BUFFERED. A term is tens of thousands of orders, each with its
 * line items joined; materialising that as one array and then one string would
 * blow a Worker's 128 MB isolate long before the response was written. Instead
 * the export walks the range with the same keyset cursor the kitchen board
 * uses — one bounded batch in memory at a time — and pushes each batch's rows
 * into a ReadableStream as they are read. Peak memory is a batch, not a term.
 *
 * The window is also capped (MAX_EXPORT_WINDOW_DAYS) so `?from=1970-01-01`
 * cannot ask for a full-table scan; a longer period is exported as consecutive
 * requests, which is what "dated export" means in practice anyway.
 *
 * GUESTS. `studentId` is nullable — a walk-up order has `guestName`/
 * `guestPhone` and no account. Both shapes appear in the same file, told apart
 * by the `customerType` column, so the books balance against total takings
 * rather than only against account holders.
 */

/** Widest `from`..`to` span a single export may cover — one academic term. */
export const MAX_EXPORT_WINDOW_DAYS = 92;
/** Window used when the caller gives neither bound. */
export const DEFAULT_EXPORT_LOOKBACK_DAYS = 30;
/** Orders held in memory at once. */
export const EXPORT_BATCH_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrderExportOptions {
  from?: Date;
  to?: Date;
  kitchen?: string;
  statuses?: string[];
}

export interface ResolvedExportWindow {
  from: Date;
  to: Date;
}

export function resolveExportWindow(options: OrderExportOptions): ResolvedExportWindow {
  const { from, to } = options;
  if (from && Number.isNaN(from.getTime())) {
    throw new ApiError(400, "INVALID_DATE_RANGE", "`from` is not a valid date");
  }
  if (to && Number.isNaN(to.getTime())) {
    throw new ApiError(400, "INVALID_DATE_RANGE", "`to` is not a valid date");
  }

  const resolvedTo = to ?? new Date();
  const resolvedFrom = from ?? new Date(resolvedTo.getTime() - DEFAULT_EXPORT_LOOKBACK_DAYS * DAY_MS);

  if (resolvedFrom.getTime() > resolvedTo.getTime()) {
    throw new ApiError(400, "INVALID_DATE_RANGE", "`from` must not be after `to`");
  }
  if (resolvedTo.getTime() - resolvedFrom.getTime() > MAX_EXPORT_WINDOW_DAYS * DAY_MS) {
    throw new ApiError(
      400,
      "DATE_RANGE_TOO_WIDE",
      `Export window may not exceed ${MAX_EXPORT_WINDOW_DAYS} days — export consecutive periods instead`,
    );
  }
  return { from: resolvedFrom, to: resolvedTo };
}

/** `YYYY-MM-DD`, for the download filename. */
export function exportDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const ORDER_EXPORT_COLUMNS = [
  "orderNumber",
  "orderId",
  "createdAt",
  "collectionAt",
  "deliveredAt",
  "status",
  "kitchen",
  "customerType",
  "customerName",
  "rollNumber",
  "email",
  "phone",
  "itemCount",
  "items",
  "totalAmount",
] as const;

/**
 * RFC 4180 quoting. Every field is quoted rather than only the ones that need
 * it: a student name containing a comma and a menu item containing a quote are
 * both realistic, and unconditional quoting removes the class of bug where one
 * of them shifts every later column of that row.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function csvRow(values: unknown[]): string {
  return `${values.map(csvField).join(",")}\n`;
}

/**
 * Base `Order` columns for one export row, read directly (matches column
 * names 1:1 — see src/db/schema.ts's doc comment). `studentId` rides along
 * only to drive the student join in hydrateExportRows(); it never reaches
 * ORDER_EXPORT_COLUMNS.
 */
interface ExportOrderRow {
  id: string;
  orderNumber: number;
  createdAt: Date;
  collectionAt: Date | null;
  deliveredAt: Date | null;
  status: string;
  kitchen: string;
  totalAmount: string;
  guestName: string | null;
  guestPhone: string | null;
  guestSessionId: string | null;
  studentId: string | null;
}

/**
 * Hand-written replacement for
 * `Prisma.OrderGetPayload<{ select: typeof EXPORT_SELECT }>` — the 3-level
 * nested Prisma select (Order -> items -> menuItem, Order -> student) this
 * export used to declare.
 */
export interface ExportRow extends ExportOrderRow {
  student: { id: string; name: string; rollNumber: string | null; email: string } | null;
  items: { quantity: number; menuItem: { name: string } }[];
}

function toCsvLine(order: ExportRow): string {
  // Same STUDENT/GUEST resolution the admin board uses, so a name in the
  // export matches the name the kitchen saw on the screen.
  const { customer } = withCustomer(order);
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);
  const items = order.items.map((i) => `${i.menuItem.name} x${i.quantity}`).join(" | ");

  return csvRow([
    order.orderNumber,
    order.id,
    order.createdAt.toISOString(),
    order.collectionAt?.toISOString() ?? "",
    order.deliveredAt?.toISOString() ?? "",
    order.status,
    order.kitchen,
    customer.type,
    customer.name,
    customer.rollNumber ?? "",
    order.student?.email ?? "",
    customer.phone ?? "",
    itemCount,
    items,
    Number(order.totalAmount).toFixed(2),
  ]);
}

function buildExportWhere(
  window: ResolvedExportWindow,
  options: OrderExportOptions,
  cursor: { createdAt: Date; id: string } | null,
) {
  const where = new WhereBuilder();
  // Bounds are ISO-UTC strings cast to `::timestamp`, not raw Date params: a
  // bare Date object handed to the driver as a parameter for a `timestamp
  // without time zone` column is serialized using the process's *local*
  // wall-clock time, not UTC, silently shifting the comparison by the host's
  // UTC offset. Casting an ISO string sidesteps that.
  where.and(`"createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`, window.from.toISOString(), window.to.toISOString());
  if (options.kitchen) where.and(`"kitchen" = $1::"Kitchen"`, options.kitchen);
  if (options.statuses?.length) where.and(`"status"::text = ANY($1::text[])`, options.statuses);
  if (cursor) {
    // Strictly "after" the cursor row in (createdAt ASC, id ASC) order. The
    // export reads oldest-first because a ledger is read in the order the
    // money came in.
    where.and(
      `("createdAt" > $1::timestamp OR ("createdAt" = $1::timestamp AND "id" > $2))`,
      cursor.createdAt.toISOString(),
      cursor.id,
    );
  }
  return where.build();
}

/** Row count the export will produce — cheap enough to report in the audit log. */
export async function countExportRows(
  pool: Pool,
  window: ResolvedExportWindow,
  options: OrderExportOptions,
): Promise<number> {
  const { rows } = await query<{ count: string }>(
    pool,
    sql`SELECT COUNT(*)::text AS count FROM "Order" WHERE ${buildExportWhere(window, options, null)}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Joins one batch of base order rows to their items+menuItem and their
 * student, matching orderService.ts's own hydrateOrders idiom (one query for
 * items, one for students, joined in memory) rather than sharing that
 * function directly — this export's row shape is narrower (only the item
 * name/quantity and a thinner student summary are ever written to CSV).
 */
async function hydrateExportRows(pool: Pool, orders: ExportOrderRow[]): Promise<ExportRow[]> {
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const studentIds = [...new Set(orders.map((o) => o.studentId).filter((id): id is string => Boolean(id)))];

  const [{ rows: itemRows }, { rows: studentRows }] = await Promise.all([
    query<{ orderId: string; quantity: number; menuItemName: string }>(
      pool,
      sql`
      SELECT oi."orderId" AS "orderId", oi."quantity" AS "quantity", mi."name" AS "menuItemName"
        FROM "OrderItem" oi
        JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
       WHERE oi."orderId" = ANY(${orderIds}::text[])
    `,
    ),
    studentIds.length > 0
      ? query<{ id: string; name: string; rollNumber: string | null; email: string }>(
          pool,
          sql`SELECT "id", "name", "rollNumber", "email" FROM "User" WHERE "id" = ANY(${studentIds}::text[])`,
        )
      : Promise.resolve({
          rows: [] as { id: string; name: string; rollNumber: string | null; email: string }[],
          rowCount: 0,
        }),
  ]);

  const itemsByOrder = new Map<string, { quantity: number; menuItem: { name: string } }[]>();
  for (const row of itemRows) {
    const bucket = itemsByOrder.get(row.orderId) ?? [];
    bucket.push({ quantity: row.quantity, menuItem: { name: row.menuItemName } });
    itemsByOrder.set(row.orderId, bucket);
  }
  const studentById = new Map(studentRows.map((s) => [s.id, s]));

  return orders.map((order) => ({
    ...order,
    items: itemsByOrder.get(order.id) ?? [],
    student: order.studentId ? (studentById.get(order.studentId) ?? null) : null,
  }));
}

async function fetchExportBatch(
  pool: Pool,
  window: ResolvedExportWindow,
  options: OrderExportOptions,
  cursor: { createdAt: Date; id: string } | null,
): Promise<ExportOrderRow[]> {
  const { rows } = await query<ExportOrderRow>(
    pool,
    sql`
    SELECT "id", "orderNumber", "createdAt", "collectionAt", "deliveredAt", "status", "kitchen",
           "totalAmount"::text AS "totalAmount", "guestName", "guestPhone", "guestSessionId", "studentId"
      FROM "Order"
     WHERE ${buildExportWhere(window, options, cursor)}
     ORDER BY "createdAt" ASC, "id" ASC
     LIMIT ${EXPORT_BATCH_SIZE}
  `,
  );
  return rows;
}

/**
 * The export body. Each `pull` reads one batch and enqueues it, so the runtime
 * applies backpressure: nothing is read from the database faster than the
 * client can accept it.
 */
export function streamOrdersCsv(
  pool: Pool,
  window: ResolvedExportWindow,
  options: OrderExportOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor: { createdAt: Date; id: string } | null = null;
  let done = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow([...ORDER_EXPORT_COLUMNS])));
    },
    async pull(controller) {
      if (done) return;

      let batch: ExportRow[];
      try {
        const baseRows = await fetchExportBatch(pool, window, options, cursor);
        batch = await hydrateExportRows(pool, baseRows);
      } catch (err) {
        // The headers are already sent by the time this runs, so there is no
        // way to turn this into an HTTP error. Erroring the stream truncates
        // the download instead of silently handing over a short file that
        // looks complete.
        controller.error(err);
        return;
      }

      for (const order of batch) {
        controller.enqueue(encoder.encode(toCsvLine(order)));
      }

      if (batch.length < EXPORT_BATCH_SIZE) {
        done = true;
        controller.close();
        return;
      }
      const last = batch[batch.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    },
  });
}
