import { prisma } from "./db.js";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { batchAudience, publish, room } from "./events.js";
import { log } from "./logger.js";
import { REVIEW_STATUSES } from "./batches/workflow.js";

/**
 * Runs every minute in each worker; safe to run in several workers at once.
 *  1. SLA escalation: a batch waiting at one stage longer than SLA_MINUTES is flagged and
 *     the state office is alerted live, without anyone having to chase it.
 *  2. Housekeeping: delete finished jobs older than 7 days.
 */
export async function sweep(): Promise<void> {
  await escalateOverdueBatches();
  await prisma.job.deleteMany({ where: { status: "DONE", updatedAt: { lt: new Date(Date.now() - 7 * 24 * 3_600_000) } } });
}

export async function escalateOverdueBatches(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.slaMinutes * 60_000);
  const overdue = await prisma.batch.findMany({
    where: { status: { in: [...REVIEW_STATUSES] }, stageEnteredAt: { lt: cutoff }, escalatedAt: null },
    include: { centre: true },
  });

  let escalated = 0;
  for (const batch of overdue) {
    const done = await prisma.$transaction(async (tx) => {
      // Conditional update: if two workers sweep at once, only one escalates.
      const { count } = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status, escalatedAt: null },
        data: { escalatedAt: now },
      });
      if (count === 0) return false;
      const waitingMinutes = Math.round((now.getTime() - batch.stageEnteredAt.getTime()) / 60_000);
      await audit(tx, {
        entityType: "batch", entityId: batch.id, batchId: batch.id, action: "SLA_ESCALATED", actorId: null,
        details: { status: batch.status, waitingMinutes, slaMinutes: config.slaMinutes },
      });
      return true;
    });
    if (!done) continue;
    escalated++;
    log.warn("batch escalated", { batchId: batch.id, status: batch.status });
    await publish({
      type: "batch.escalated",
      rooms: [room.role("STATE"), ...batchAudience({ centreId: batch.centreId, districtId: batch.centre.districtId })],
      payload: { batchId: batch.id, number: batch.number, status: batch.status },
    });
  }
  return escalated;
}
