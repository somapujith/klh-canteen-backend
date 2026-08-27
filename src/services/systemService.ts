import type { Pool } from "@neondatabase/serverless";
import { sql, query } from "../db/sql.js";

export async function getStorageStats(pool: Pool) {
  const { rows: statsRows } = await query<{ table_name: string; size: string }>(
    pool,
    sql`
    SELECT relname as table_name, pg_total_relation_size(relid)::text as size
    FROM pg_catalog.pg_statio_user_tables;
  `,
  );

  const stats = {
    ordersAndLogs: 0,
    userAccounts: 0,
    menuAndConfig: 0,
    systemOverhead: 0,
  };

  statsRows.forEach((row) => {
    const size = Number(row.size);
    const table = row.table_name;

    if (table === 'Order' || table === 'OrderItem' || table === 'OrderSequence') {
      stats.ordersAndLogs += size;
    } else if (table === 'User') {
      stats.userAccounts += size;
    } else if (table === 'Category' || table === 'MenuItem') {
      stats.menuAndConfig += size;
    } else {
      stats.systemOverhead += size;
    }
  });

  return {
    totalSize: stats.ordersAndLogs + stats.userAccounts + stats.menuAndConfig + stats.systemOverhead,
    limit: 524288000, // 500 MB Free Tier
    components: [
      { id: 'orders', name: 'Orders & Logs', size: stats.ordersAndLogs, color: 'bg-blue-500', removable: true },
      { id: 'users', name: 'User Accounts', size: stats.userAccounts, color: 'bg-green-500', removable: false },
      { id: 'menu', name: 'Menu & Config', size: stats.menuAndConfig, color: 'bg-orange-500', removable: false },
      { id: 'system', name: 'System Overhead', size: stats.systemOverhead, color: 'bg-gray-400', removable: false },
    ]
  };
}

export async function clearStorage(pool: Pool, target: string, retainDays: number = 0) {
  if (target === 'orders') {
    // Delete delivered orders older than retainDays
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retainDays);

    // Find all delivered orders to delete. Cast as an ISO-UTC string, not a
    // raw Date param — a bare Date object serializes using the process's
    // local wall-clock time for a `timestamp without time zone` column,
    // silently shifting this comparison by the host's UTC offset.
    const { rows: ordersToDelete } = await query<{ id: string }>(
      pool,
      sql`SELECT "id" FROM "Order" WHERE "status" = 'DELIVERED'::"OrderStatus" AND "createdAt" < ${cutoffDate.toISOString()}::timestamp`,
    );

    const orderIds = ordersToDelete.map((o) => o.id);

    if (orderIds.length > 0) {
      // Delete items, then orders — two sequential statements, not wrapped in
      // a transaction, preserving the original findMany + deleteMany +
      // deleteMany shape. This is a superadmin-only, deliberately manual
      // cleanup action (not on any hot path), so the small window in which a
      // crash between the two DELETEs could leave orphaned OrderItem rows for
      // an already-deleted Order is an acceptable trade against not holding a
      // transaction/connection open across a batch that can be very large.
      await query(pool, sql`DELETE FROM "OrderItem" WHERE "orderId" = ANY(${orderIds}::text[])`);
      const { rowCount: deletedCount } = await query(
        pool,
        sql`DELETE FROM "Order" WHERE "id" = ANY(${orderIds}::text[])`,
      );
      return { success: true, deletedCount };
    }
    return { success: true, deletedCount: 0 };
  }

  throw new Error("Invalid clearing target");
}
