import type { PrismaClient } from "@prisma/client";

export async function getStorageStats(prisma: PrismaClient) {
  const query = await prisma.$queryRaw<{ table_name: string; size: bigint }[]>`
    SELECT relname as table_name, pg_total_relation_size(relid) as size
    FROM pg_catalog.pg_statio_user_tables;
  `;

  const stats = {
    ordersAndLogs: 0,
    userAccounts: 0,
    menuAndConfig: 0,
    systemOverhead: 0,
  };

  query.forEach((row) => {
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

export async function clearStorage(prisma: PrismaClient, target: string, retainDays: number = 0) {
  if (target === 'orders') {
    // Delete delivered orders older than retainDays
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retainDays);

    // Find all delivered orders to delete
    const ordersToDelete = await prisma.order.findMany({
      where: {
        status: 'DELIVERED',
        createdAt: { lt: cutoffDate }
      },
      select: { id: true }
    });

    const orderIds = ordersToDelete.map(o => o.id);

    if (orderIds.length > 0) {
      // Delete items
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } }
      });
      // Delete orders
      const deletedOrders = await prisma.order.deleteMany({
        where: { id: { in: orderIds } }
      });
      return { success: true, deletedCount: deletedOrders.count };
    }
    return { success: true, deletedCount: 0 };
  }

  throw new Error("Invalid clearing target");
}
