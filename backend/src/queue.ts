/**
 * A small, reliable job queue stored in PostgreSQL.
 *
 * - enqueue() runs INSIDE the caller's transaction: the job exists if and only if the
 *   change that caused it committed. No "approved but never issued" gap.
 * - Each job has a unique `key`, so enqueueing the same work twice is a no-op.
 * - Workers claim jobs with `FOR UPDATE SKIP LOCKED`: any number of workers can poll at
 *   once and each job goes to exactly one of them, without blocking each other.
 * - A job whose worker died (lock older than 5 minutes) is claimed again.
 * - Failures retry with exponential backoff up to maxAttempts, then stay FAILED.
 *
 * A job can still run twice (a worker finishes the work, then dies before marking it
 * done), so every job handler is idempotent.
 */
import { prisma, type Tx } from "./db.js";

export type JobName = "issue-batch" | "render-pdf" | "send-whatsapp";

/** NOTIFY channel that wakes idle workers as soon as a job is enqueued. */
export const JOBS_CHANNEL = "certiflow_jobs";

export const jobKeys = {
  issueBatch: (batchId: string) => `issue-batch:${batchId}`,
  renderPdf: (certificateId: string) => `render-pdf:${certificateId}`,
  sendWhatsapp: (certificateId: string) => `send-whatsapp:${certificateId}`,
};

export interface ClaimedJob {
  id: string;
  name: JobName;
  payload: Record<string, string>;
  attempts: number;
  maxAttempts: number;
}

/** Add a job as part of the caller's transaction. Does nothing if `key` already exists. */
export async function enqueue(tx: Tx, name: JobName, key: string, payload: Record<string, string>): Promise<void> {
  await tx.job.createMany({ data: [{ name, key, payload }], skipDuplicates: true });
  // NOTIFY is delivered on COMMIT (dropped on rollback): wakes a waiting worker immediately.
  await tx.$executeRaw`SELECT pg_notify(${JOBS_CHANNEL}, '')`;
}

/**
 * Claim up to `limit` runnable jobs for this worker.
 * Timestamps are stored as UTC without a time zone, so compare with UTC "now"
 * (plain now() would be off by the database server's time zone).
 */
export async function claimJobs(workerId: string, limit: number): Promise<ClaimedJob[]> {
  return prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'RUNNING',
        "lockedAt" = (now() AT TIME ZONE 'UTC'),
        "lockedBy" = ${workerId},
        attempts = attempts + 1,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE (status = 'PENDING' AND "runAt" <= (now() AT TIME ZONE 'UTC'))
         OR (status = 'RUNNING' AND "lockedAt" < (now() AT TIME ZONE 'UTC') - interval '5 minutes')
      ORDER BY "runAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, payload, attempts, "maxAttempts"`;
}

/** Mark done, only if this worker still holds the job (it may have been reclaimed). */
export async function completeJob(job: ClaimedJob, workerId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: job.id, lockedBy: workerId, status: "RUNNING" },
    data: { status: "DONE", lockedAt: null, lockedBy: null, lastError: null },
  });
}

/** Schedule a retry with exponential backoff (2s, 4s, 8s ... max 10 min), or give up. */
export async function failJob(job: ClaimedJob, workerId: string, error: unknown): Promise<"retry" | "failed"> {
  const finalAttempt = job.attempts >= job.maxAttempts;
  const delayMs = Math.min(2 ** job.attempts * 1_000, 10 * 60_000);
  const message = error instanceof Error ? error.message : String(error);
  await prisma.job.updateMany({
    where: { id: job.id, lockedBy: workerId, status: "RUNNING" },
    data: {
      status: finalAttempt ? "FAILED" : "PENDING",
      runAt: new Date(Date.now() + delayMs),
      lockedAt: null,
      lockedBy: null,
      lastError: message.slice(0, 2_000),
    },
  });
  return finalAttempt ? "failed" : "retry";
}
