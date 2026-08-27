import type { Pool, PoolClient } from "@neondatabase/serverless";
import { insertAuditLog, findAuditLogs } from "../db/auditLogRepo.js";
import type { AuditLogWithActor } from "../db/auditLogRepo.js";

type Runner = Pool | PoolClient;

/**
 * Audit writes are best-effort: a failure here must never block the
 * operation being logged, so every error is swallowed after being logged to
 * the console. Do not tighten this — see callers across adminMenu.ts,
 * adminOrders.ts, auth.ts, superadmin*.ts, telegram.ts, none of which check
 * this call's outcome.
 */
export async function logAction(
  runner: Runner,
  actorId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await insertAuditLog(runner, { actorId, action, targetType, targetId, metadata });
  } catch (err) {
    console.error("Failed to write audit log", { actorId, action, err });
  }
}

export async function getAuditLog(runner: Runner, limit: number, before?: string): Promise<AuditLogWithActor[]> {
  return findAuditLogs(runner, { limit, before: before ? new Date(before) : undefined });
}
