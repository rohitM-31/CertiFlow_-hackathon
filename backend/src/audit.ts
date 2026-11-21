import type { Tx } from "./db.js";
import type { Prisma } from "./generated/prisma/client.js";

export interface AuditEntry {
  entityType: "batch" | "certificate";
  entityId: string;
  batchId: string;
  action: string;
  actorId: string | null; // null = system (worker / scheduler)
  details?: Prisma.InputJsonValue;
}

/**
 * Write an audit record. Always pass the SAME transaction that makes the change,
 * so the change and its audit record commit together or not at all.
 */
export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      batchId: entry.batchId,
      action: entry.action,
      actorId: entry.actorId,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    },
  });
}
