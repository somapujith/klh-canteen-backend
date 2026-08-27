/**
 * Raw-SQL data access for the "AuditLog" table, replacing `prisma.auditLog.*`
 * calls in src/services/auditService.ts.
 *
 * `metadata` is Postgres `jsonb`. Verified directly against the running test
 * database (@neondatabase/serverless v1.1.0): a plain JS object/array passed
 * as a query parameter is auto-serialized on INSERT and auto-deserialized
 * back into an object on SELECT — no `JSON.stringify`/`JSON.parse` needed,
 * same as node-postgres.
 */
import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, raw, query } from "./sql.js";
import type { AuditLog, Role } from "./schema.js";

export type Runner = Pool | PoolClient;

const LOG_COLUMNS = `"id", "actorId", "action", "targetType", "targetId", "metadata", "createdAt"`;

export interface AuditLogCreateInput {
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
}

/** Identity fields the audit log view needs — never the full User row. */
export interface AuditLogActor {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface AuditLogWithActor extends AuditLog {
  actor: AuditLogActor;
}

export async function insertAuditLog(runner: Runner, data: AuditLogCreateInput): Promise<AuditLog> {
  const { rows } = await query<AuditLog>(
    runner,
    sql`
      INSERT INTO "AuditLog" ("id", "actorId", "action", "targetType", "targetId", "metadata")
      VALUES (
        ${crypto.randomUUID()}, ${data.actorId}, ${data.action},
        ${data.targetType ?? null}, ${data.targetId ?? null}, ${data.metadata ?? null}
      )
      RETURNING ${raw(LOG_COLUMNS)}
    `
  );
  return rows[0];
}

/**
 * Mirrors `prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" },
 * take: limit, include: { actor: { select: {...} } } })`. A single JOIN
 * rather than a second query — this is a bounded, paginated list (`limit` is
 * capped by the route's zod schema), not an unbounded fan-out, so there is
 * no N+1 concern the two-query idiom exists to avoid.
 */
export async function findAuditLogs(
  runner: Runner,
  opts: { limit: number; before?: Date }
): Promise<AuditLogWithActor[]> {
  const beforeFilter = opts.before ? sql`WHERE al."createdAt" < ${opts.before}` : sql``;
  const { rows } = await query<
    AuditLog & { actorName: string; actorEmail: string; actorRole: Role }
  >(
    runner,
    sql`
      SELECT al."id", al."actorId", al."action", al."targetType", al."targetId", al."metadata", al."createdAt",
             u."name" AS "actorName", u."email" AS "actorEmail", u."role" AS "actorRole"
      FROM "AuditLog" al
      JOIN "User" u ON u."id" = al."actorId"
      ${beforeFilter}
      ORDER BY al."createdAt" DESC
      LIMIT ${opts.limit}
    `
  );
  return rows.map(({ actorName, actorEmail, actorRole, ...log }) => ({
    ...log,
    actor: { id: log.actorId, name: actorName, email: actorEmail, role: actorRole },
  }));
}
