import type { Prisma, PrismaClient } from "@prisma/client";
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

const EXPORT_SELECT = {
  id: true,
  orderNumber: true,
  createdAt: true,
  collectionAt: true,
  deliveredAt: true,
  status: true,
  kitchen: true,
  totalAmount: true,
  guestName: true,
  guestPhone: true,
  guestSessionId: true,
  student: { select: { id: true, name: true, rollNumber: true, email: true } },
  items: { select: { quantity: true, menuItem: { select: { name: true } } } },
} as const;

type ExportRow = Prisma.OrderGetPayload<{ select: typeof EXPORT_SELECT }>;

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
): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [
    { createdAt: { gte: window.from, lte: window.to } },
  ];
  if (options.kitchen) and.push({ kitchen: options.kitchen as any });
  if (options.statuses?.length) and.push({ status: { in: options.statuses as any } });
  if (cursor) {
    // Strictly "after" the cursor row in (createdAt ASC, id ASC) order. The
    // export reads oldest-first because a ledger is read in the order the
    // money came in.
    and.push({
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.id } }] },
      ],
    });
  }
  return { AND: and };
}

/** Row count the export will produce — cheap enough to report in the audit log. */
export async function countExportRows(
  prisma: PrismaClient,
  window: ResolvedExportWindow,
  options: OrderExportOptions,
): Promise<number> {
  return prisma.order.count({ where: buildExportWhere(window, options, null) });
}

/**
 * The export body. Each `pull` reads one batch and enqueues it, so the runtime
 * applies backpressure: nothing is read from the database faster than the
 * client can accept it.
 */
export function streamOrdersCsv(
  prisma: PrismaClient,
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
        batch = await prisma.order.findMany({
          where: buildExportWhere(window, options, cursor),
          select: EXPORT_SELECT,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: EXPORT_BATCH_SIZE,
        });
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
