import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function logAction(
  actorId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { actorId, action, targetType, targetId, metadata: metadata as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.error("Failed to write audit log", { actorId, action, err });
  }
}

export async function getAuditLog(limit: number, before?: string) {
  return prisma.auditLog.findMany({
    where: before ? { createdAt: { lt: new Date(before) } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  });
}
