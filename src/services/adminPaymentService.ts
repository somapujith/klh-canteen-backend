import type { Pool } from "@neondatabase/serverless";
import { sql, query } from "../db/sql.js";
import type { School } from "../db/schema.js";
import { getPlatformFeePercent } from "../db/schoolSettingsRepo.js";

export interface AdminPaymentStats {
  thisMonthTotal: string;
  commission: string;
  commissionPercent: number;
}

export interface PaginatedAdminPayments {
  data: AdminPaymentRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminPaymentRow {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
  studentName: string | null;
  guestName: string | null;
}

export async function getAdminPaymentStats(pool: Pool, school: School): Promise<AdminPaymentStats> {
  const percent = await getPlatformFeePercent(pool, school);
  // Default to 3 for KLH, 2 for DRK if not set? Wait, if 0 is returned, maybe we use 0. 
  // Let's use the DB value if set, else hardcode the fallback user wants just in case, or maybe just trust DB.
  // The user says "as KLH have 3% and DRK have 2% accordingly". I will hardcode the fallback:
  const actualPercent = percent > 0 ? percent : (school === "KLH" ? 3 : 2);

  // This month's successful payments
  // We need to join Payment with Order to filter by school.
  const { rows } = await query<{ total: string }>(
    pool,
    sql`
      SELECT COALESCE(SUM(p."amount"), 0) AS total
      FROM "Payment" p
      WHERE p."status" = 'SUCCESS'
        AND date_trunc('month', p."createdAt") = date_trunc('month', CURRENT_DATE)
        AND p."id" IN (
          SELECT "paymentId" FROM "Order" WHERE "school" = ${school}::"School" AND "paymentId" IS NOT NULL
        )
    `
  );

  const total = Number(rows[0]?.total || 0);
  const commissionValue = (total * actualPercent) / 100;

  return {
    thisMonthTotal: total.toFixed(2),
    commission: commissionValue.toFixed(2),
    commissionPercent: actualPercent,
  };
}

export async function getAdminPaymentsList(
  pool: Pool,
  school: School,
  cursor: string | undefined,
  limit: number,
  isToday: boolean
): Promise<PaginatedAdminPayments> {
  const limitPlusOne = limit + 1;

  let timeFilter = sql``;
  if (isToday) {
    timeFilter = sql`AND date_trunc('day', p."createdAt") = date_trunc('day', CURRENT_DATE)`;
  }

  let cursorFilter = sql``;
  if (cursor) {
    // cursor is payment id. we need createdAt for cursor pagination, or we can just sort by createdAt DESC, id DESC.
    // Since this is a simple dashboard, maybe just offset pagination? The prompt says "live pagination" meaning standard next cursor.
    // For simplicity, let's parse cursor as an offset for now, or fetch createdAt of cursor.
    // Actually, a simpler cursor is just the createdAt timestamp.
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const [createdAt, id] = decoded.split("|");
    if (createdAt && id) {
      cursorFilter = sql`AND (p."createdAt", p."id") < (${new Date(createdAt).toISOString()}::timestamp, ${id}::text)`;
    }
  }

  const { rows } = await query<any>(
    pool,
    sql`
      SELECT p."id", p."amount", p."status", p."createdAt", p."paidAt",
             u."name" as "studentName",
             (SELECT o."guestName" FROM "Order" o WHERE o."paymentId" = p."id" LIMIT 1) as "guestName"
      FROM "Payment" p
      LEFT JOIN "User" u ON p."studentId" = u."id"
      WHERE p."id" IN (
          SELECT "paymentId" FROM "Order" WHERE "school" = ${school}::"School" AND "paymentId" IS NOT NULL
      )
      ${timeFilter}
      ${cursorFilter}
      ORDER BY p."createdAt" DESC, p."id" DESC
      LIMIT ${limitPlusOne}
    `
  );

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = data[data.length - 1];
    nextCursor = Buffer.from(`${new Date(last.createdAt).toISOString()}|${last.id}`).toString("base64");
  }

  return {
    data: data.map(r => ({
      id: r.id,
      amount: Number(r.amount).toFixed(2),
      status: r.status,
      createdAt: new Date(r.createdAt).toISOString(),
      paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
      studentName: r.studentName,
      guestName: r.guestName,
    })),
    nextCursor,
    hasMore
  };
}
