import { prisma, isUniqueViolation } from "../db.js";
import { audit } from "../audit.js";
import { batchAudience, publish } from "../events.js";
import { enqueue, jobKeys } from "../queue.js";
import { log } from "../logger.js";
import { newCertificateNumber, newDownloadToken } from "./ids.js";

/**
 * Job "issue-batch": create one certificate per candidate of an APPROVED batch, then
 * mark the batch ISSUED. Refuses to do anything for a batch that isn't approved, so
 * certificates can never appear before all mandatory approvals.
 *
 * Idempotent: safe to run twice, in two workers at once, or again after a crash halfway.
 * Candidates that already have a certificate are skipped, and the unique constraint on
 * Certificate.candidateId makes a second certificate impossible even under a race.
 *
 * Each certificate and its "render-pdf" job are created in one transaction, so every
 * certificate is guaranteed to get its PDF (and then its WhatsApp message).
 *
 * Returns how many certificates this run created.
 */
export async function issueCertificatesForBatch(batchId: string): Promise<number> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { centre: true, candidates: { include: { certificate: { select: { id: true } } } } },
  });
  if (!batch) {
    log.warn("issue-batch: batch not found", { batchId });
    return 0;
  }
  if (batch.status !== "APPROVED" && batch.status !== "ISSUED") {
    log.warn("issue-batch: batch is not approved, refusing", { batchId, status: batch.status });
    return 0;
  }

  let created = 0;
  for (const candidate of batch.candidates) {
    if (candidate.certificate) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await prisma.$transaction(async (tx) => {
          const cert = await tx.certificate.create({
            data: {
              number: newCertificateNumber(),
              downloadToken: newDownloadToken(),
              candidateId: candidate.id,
              enrollmentNo: candidate.enrollmentNo,
              batchId,
            },
          });
          await audit(tx, {
            entityType: "certificate", entityId: cert.id, batchId, action: "CERTIFICATE_ISSUED", actorId: null,
            details: { number: cert.number, enrollmentNo: candidate.enrollmentNo },
          });
          // Fan out: one small job per PDF, so many workers can render in parallel.
          await enqueue(tx, "render-pdf", jobKeys.renderPdf(cert.id), { certificateId: cert.id, batchId });
        });
        created++;
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // real failure: the job is retried
        // Which unique rule fired? If this candidate (or enrolment) already has a
        // certificate, another run got there first: skip. Otherwise the random number
        // collided (astronomically rare): try again with a new number.
        const existing = await prisma.certificate.findFirst({
          where: { OR: [{ candidateId: candidate.id }, { enrollmentNo: candidate.enrollmentNo }] },
          select: { candidateId: true },
        });
        if (existing) {
          if (existing.candidateId !== candidate.id) {
            log.warn("enrolment already certified via another batch; skipped", { batchId, enrollmentNo: candidate.enrollmentNo });
          }
          break;
        }
        if (attempt === 3) throw err;
      }
    }
  }

  // Mark ISSUED exactly once (conditional update: only if still APPROVED).
  const marked = await prisma.$transaction(async (tx) => {
    const { count } = await tx.batch.updateMany({ where: { id: batchId, status: "APPROVED" }, data: { status: "ISSUED" } });
    if (count === 1) {
      await audit(tx, {
        entityType: "batch", entityId: batchId, batchId, action: "STATUS_CHANGED", actorId: null,
        details: { from: "APPROVED", to: "ISSUED", certificatesCreated: created },
      });
    }
    return count === 1;
  });
  if (marked) {
    log.info("batch issued", { batchId, certificatesCreated: created });
    await publish({
      type: "batch.updated",
      rooms: batchAudience({ centreId: batch.centreId, districtId: batch.centre.districtId }),
      payload: { batchId, number: batch.number, status: "ISSUED" },
    });
  }
  return created;
}
