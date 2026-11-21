import { prisma, type Tx } from "../db.js";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors.js";
import { batchAudience, publish } from "../events.js";
import { enqueue, jobKeys } from "../queue.js";
import type { AuthUser } from "../auth/middleware.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { BatchStatus, DecisionType } from "../generated/prisma/enums.js";
import { parseCandidatesCsv, type CandidateRow, type RowError } from "./csv.js";
import { assertCanDecide, canViewBatch, nextStatusAfterApproval, nextStatusAfterObjection, REVIEW_STATUSES } from "./workflow.js";

/** 422 with every row problem. Thrown before anything is written. */
export class UploadRejected extends HttpError {
  constructor(public readonly rowErrors: RowError[]) {
    super(422, `The file has ${rowErrors.length} problem(s). Nothing was saved. Fix them and upload again.`, rowErrors);
  }
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(id: string): void {
  if (!UUID_RE.test(id)) throw notFound("Batch not found");
}

/**
 * Lock one batch row until the surrounding transaction ends (SELECT ... FOR UPDATE).
 * Another transaction locking the same batch waits its turn, so two officers clicking
 * "approve" at the same instant are processed one after the other, and the second sees
 * the first one's vote. Returns false if the batch doesn't exist.
 */
async function lockBatch(tx: Tx, batchId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
  return rows.length > 0;
}

/** Prisma filter: the batches this user may see. */
export function visibleBatchesFilter(user: AuthUser): Prisma.BatchWhereInput {
  switch (user.role) {
    case "CENTRE":
      return { centreId: user.centreId ?? "__none__" };
    case "DISTRICT_OFFICER":
      return { centre: { districtId: user.districtId ?? "__none__" } };
    case "QUALITY":
    case "STATE":
      return {};
  }
}

async function loadVisibleBatch(tx: Tx, user: AuthUser, batchId: string) {
  assertUuid(batchId);
  const batch = await tx.batch.findUnique({
    where: { id: batchId },
    include: { centre: true, _count: { select: { candidates: true } } },
  });
  if (!batch || !canViewBatch(user, batch)) throw notFound("Batch not found");
  return batch;
}

function notifyBatchChanged(batch: { id: string; number: number; status: BatchStatus; centreId: string; centre: { districtId: string } }) {
  return publish({
    type: "batch.updated",
    rooms: batchAudience({ centreId: batch.centreId, districtId: batch.centre.districtId }),
    payload: { batchId: batch.id, number: batch.number, status: batch.status },
  });
}

/** Validate the file completely before touching the database. */
function parseOrReject(file: UploadedFile): CandidateRow[] {
  if (!/\.csv$/i.test(file.originalname)) throw badRequest("Only .csv files are accepted");
  const { rows, errors } = parseCandidatesCsv(file.buffer, config.maxCandidatesPerBatch);
  if (errors.length > 0) throw new UploadRejected(errors);
  return rows;
}

/** One enrolment must never be certified twice through two different batches. */
async function assertNotInOtherBatches(tx: Tx, rows: CandidateRow[], exceptBatchId: string | null) {
  const elsewhere = await tx.candidate.findMany({
    where: {
      enrollmentNo: { in: rows.map((r) => r.enrollmentNo) },
      ...(exceptBatchId ? { batchId: { not: exceptBatchId } } : {}),
      batch: { status: { not: "REJECTED" } },
    },
    select: { enrollmentNo: true, batch: { select: { number: true } } },
  });
  if (elsewhere.length === 0) return;
  const rowOf = new Map(rows.map((r, i) => [r.enrollmentNo, i + 2]));
  throw new UploadRejected(
    elsewhere.map((e) => ({
      row: rowOf.get(e.enrollmentNo) ?? 0,
      field: "enrollment_no",
      message: `enrollment_no ${e.enrollmentNo} is already in batch B-${e.batch.number}`,
    })),
  );
}

const toCandidateData = (rows: CandidateRow[], batchId: string) =>
  rows.map((r) => ({ ...r, batchId, dateOfBirth: new Date(`${r.dateOfBirth}T00:00:00Z`) }));

// ---------------------------------------------------------------- commands

/**
 * The centre's single action: upload a CSV of passed candidates.
 * If every row is valid, the batch is created WITH its candidates and goes straight to
 * district review, all in one transaction. If any row is bad, nothing is created.
 * No certificate is created here: that only happens after the final approval.
 */
export async function uploadBatch(user: AuthUser, courseName: string, file: UploadedFile) {
  if (user.role !== "CENTRE" || !user.centreId) throw forbidden("Only training centres can upload batches");
  const centreId = user.centreId;
  const rows = parseOrReject(file);

  const batch = await prisma.$transaction(async (tx) => {
    await assertNotInOtherBatches(tx, rows, null);
    const created = await tx.batch.create({
      data: { courseName, centreId, sourceFile: file.originalname, status: "DISTRICT_REVIEW", round: 1, stageEnteredAt: new Date() },
      include: { centre: true },
    });
    await tx.candidate.createMany({ data: toCandidateData(rows, created.id) });
    await audit(tx, {
      entityType: "batch", entityId: created.id, batchId: created.id, action: "BATCH_UPLOADED", actorId: user.id,
      details: { file: file.originalname, candidates: rows.length, courseName },
    });
    await audit(tx, {
      entityType: "batch", entityId: created.id, batchId: created.id, action: "SENT_FOR_APPROVAL", actorId: null,
      details: { stage: "DISTRICT", round: 1 },
    });
    return created;
  });
  await notifyBatchChanged(batch);
  return { id: batch.id, number: batch.number, status: batch.status, candidates: rows.length };
}

/**
 * After a send-back: the centre uploads a corrected CSV. Candidates are replaced and the
 * batch goes back to district review in a NEW round (earlier approvals no longer count).
 */
export async function resubmitBatch(user: AuthUser, batchId: string, file: UploadedFile) {
  if (user.role !== "CENTRE") throw forbidden("Only training centres can resubmit batches");
  const rows = parseOrReject(file);

  const batch = await prisma.$transaction(async (tx) => {
    assertUuid(batchId);
    if (!(await lockBatch(tx, batchId))) throw notFound("Batch not found");
    const batch = await loadVisibleBatch(tx, user, batchId);
    if (batch.status !== "SENT_BACK") throw conflict(`Only a sent-back batch can be resubmitted (it is ${batch.status})`);
    await assertNotInOtherBatches(tx, rows, batchId);

    await tx.candidate.deleteMany({ where: { batchId } });
    await tx.candidate.createMany({ data: toCandidateData(rows, batchId) });
    const updated = await tx.batch.update({
      where: { id: batchId },
      data: { status: "DISTRICT_REVIEW", round: { increment: 1 }, stageEnteredAt: new Date(), escalatedAt: null, sourceFile: file.originalname },
      include: { centre: true },
    });
    await audit(tx, {
      entityType: "batch", entityId: batchId, batchId, action: "BATCH_RESUBMITTED", actorId: user.id,
      details: { file: file.originalname, candidates: rows.length, round: updated.round },
    });
    return updated;
  });
  await notifyBatchChanged(batch);
  return { id: batch.id, number: batch.number, status: batch.status, round: batch.round, candidates: rows.length };
}

export interface DecisionInput {
  type: DecisionType;
  reason?: string | undefined;
}

/**
 * Record a reviewer's decision and move the batch on if the rules say so.
 *
 * Correctness under concurrency:
 *  1. The batch row is locked (FOR UPDATE), so decisions on one batch are serialised.
 *  2. A unique constraint (batch, round, stage, user) makes a second vote by the same
 *     person impossible, even from a replayed request.
 *  3. The status change uses the state read under the lock, so it happens exactly once.
 *  4. On final approval the certificate job is enqueued in the SAME transaction, so an
 *     approved batch always gets its certificates and an unapproved one never does.
 */
export async function decide(user: AuthUser, batchId: string, input: DecisionInput) {
  if (input.type !== "APPROVE" && !input.reason?.trim()) throw badRequest("A reason is required to send back or reject a batch");

  const result = await prisma.$transaction(async (tx) => {
    assertUuid(batchId);
    if (!(await lockBatch(tx, batchId))) throw notFound("Batch not found");
    const batch = await loadVisibleBatch(tx, user, batchId);
    const stage = assertCanDecide(user, batch);

    const alreadyVoted = await tx.decision.findUnique({
      where: { batchId_round_stage_userId: { batchId, round: batch.round, stage, userId: user.id } },
    });
    if (alreadyVoted) throw conflict("You have already given your decision on this batch");

    const decision = await tx.decision.create({
      data: { batchId, round: batch.round, stage, type: input.type, reason: input.reason?.trim() || null, userId: user.id },
    });
    await audit(tx, {
      entityType: "batch", entityId: batchId, batchId, action: `DECISION_${input.type}`, actorId: user.id,
      details: { stage, round: batch.round, reason: decision.reason },
    });

    let next: BatchStatus | null;
    if (input.type === "APPROVE") {
      const approvals = await tx.decision.count({ where: { batchId, round: batch.round, stage, type: "APPROVE" } });
      next = nextStatusAfterApproval(stage, approvals, batch._count.candidates, config);
    } else {
      next = nextStatusAfterObjection(input.type);
    }
    if (next === null) return batch;

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        status: next,
        ...(REVIEW_STATUSES.includes(next) ? { stageEnteredAt: new Date() } : {}),
        escalatedAt: null,
        ...(input.type !== "APPROVE" ? { lastReason: decision.reason } : {}),
      },
      include: { centre: true, _count: { select: { candidates: true } } },
    });
    await audit(tx, {
      entityType: "batch", entityId: batchId, batchId, action: "STATUS_CHANGED", actorId: user.id,
      details: { from: batch.status, to: next },
    });
    if (next === "APPROVED") {
      await enqueue(tx, "issue-batch", jobKeys.issueBatch(batchId), { batchId });
    }
    return updated;
  });

  await notifyBatchChanged(result); // after commit; losing it is harmless
  return result;
}

// ---------------------------------------------------------------- queries

export async function listBatches(user: AuthUser) {
  const batches = await prisma.batch.findMany({
    where: visibleBatchesFilter(user),
    include: {
      centre: { select: { name: true, code: true, district: { select: { name: true } } } },
      _count: { select: { candidates: true, certificates: true } },
      decisions: { select: { round: true, stage: true, type: true, userId: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return batches.map(({ decisions, ...b }) => {
    const current = decisions.filter((d) => d.round === b.round);
    return {
      ...b,
      districtApprovals: current.filter((d) => d.stage === "DISTRICT" && d.type === "APPROVE").length,
      myVoteThisRound: current.some((d) => d.userId === user.id),
    };
  });
}

export async function getBatch(user: AuthUser, batchId: string) {
  const batch = await loadVisibleBatch(prisma, user, batchId);
  const [candidates, decisions] = await Promise.all([
    prisma.candidate.findMany({
      where: { batchId },
      orderBy: { enrollmentNo: "asc" },
      include: {
        certificate: {
          select: {
            id: true, number: true, status: true, filePath: true, downloadToken: true,
            delivery: { select: { status: true, attempts: true, sentAt: true, lastError: true } },
          },
        },
      },
    }),
    prisma.decision.findMany({
      where: { batchId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { name: true, role: true } } },
    }),
  ]);
  return {
    ...batch,
    rules: { districtApprovalsRequired: config.districtApprovalsRequired, largeBatchThreshold: config.largeBatchThreshold },
    candidates: candidates.map(({ certificate, ...c }) => ({
      ...c,
      certificate: certificate && {
        id: certificate.id,
        number: certificate.number,
        status: certificate.status,
        pdfReady: certificate.filePath !== null,
        downloadUrl: `/api/certificates/${certificate.number}/download?token=${certificate.downloadToken}`,
        whatsapp: certificate.delivery,
      },
    })),
    decisions,
  };
}

export async function getTimeline(user: AuthUser, batchId: string) {
  await loadVisibleBatch(prisma, user, batchId);
  const entries = await prisma.auditLog.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => id !== null))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } });
  const byId = new Map(actors.map((a) => [a.id, a]));
  return entries.map((e) => ({ ...e, actor: e.actorId ? (byId.get(e.actorId) ?? null) : { name: "System", role: "SYSTEM" } }));
}

/** Batches waiting at a review stage longer than the SLA (state office "stuck" view). */
export async function listStuckBatches() {
  const cutoff = new Date(Date.now() - config.slaMinutes * 60_000);
  return prisma.batch.findMany({
    where: { status: { in: [...REVIEW_STATUSES] }, stageEnteredAt: { lt: cutoff } },
    include: { centre: { select: { name: true, district: { select: { name: true } } } }, _count: { select: { candidates: true } } },
    orderBy: { stageEnteredAt: "asc" },
  });
}
