import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { batchAudience, publish } from "../events.js";
import type { AuthUser } from "../auth/middleware.js";
import type { CertificateStatus } from "../generated/prisma/enums.js";
import { CERTIFICATE_NUMBER_RE, maskName } from "./ids.js";

export interface VerifyResult {
  status: CertificateStatus | "NOT_FOUND";
  valid: boolean;
  certificateNumber: string;
  holderName?: string; // masked
  course?: string;
  centre?: string;
  district?: string;
  issuedOn?: string;
  revokedOn?: string | null;
}

/**
 * Public lookup by certificate number. No login.
 *
 * Returns only what an employer needs to compare against the paper in front of them:
 * masked name, course, centre and dates. Never phone, date of birth or enrolment number.
 * Always read from the database (one unique-index lookup), so a cancellation shows on
 * the very next check: there is no cache to go stale.
 */
export async function verifyCertificate(rawNumber: string): Promise<VerifyResult> {
  const number = rawNumber.trim().toUpperCase();
  if (!CERTIFICATE_NUMBER_RE.test(number)) return { status: "NOT_FOUND", valid: false, certificateNumber: number };

  const cert = await prisma.certificate.findUnique({
    where: { number },
    include: { candidate: true, batch: { include: { centre: { include: { district: true } } } } },
  });
  if (!cert) return { status: "NOT_FOUND", valid: false, certificateNumber: number };
  return {
    status: cert.status,
    valid: cert.status === "VALID",
    certificateNumber: cert.number,
    holderName: maskName(cert.candidate.fullName),
    course: cert.batch.courseName,
    centre: cert.batch.centre.name,
    district: cert.batch.centre.district.name,
    issuedOn: cert.issuedAt.toISOString().slice(0, 10),
    revokedOn: cert.revokedAt ? cert.revokedAt.toISOString().slice(0, 10) : null,
  };
}

/** State office: search certificates (with WhatsApp delivery status). */
export async function listCertificates(user: AuthUser, search?: string) {
  if (user.role !== "STATE") throw forbidden();
  const q = search?.trim();
  return prisma.certificate.findMany({
    where: q
      ? {
          OR: [
            { number: { contains: q.toUpperCase() } },
            { enrollmentNo: { contains: q.toUpperCase() } },
            { candidate: { fullName: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {},
    include: {
      candidate: { select: { fullName: true, enrollmentNo: true } },
      batch: { select: { number: true, courseName: true, centre: { select: { name: true } } } },
      delivery: { select: { status: true, attempts: true, sentAt: true } },
    },
    orderBy: { issuedAt: "desc" },
    take: 100,
  });
}

/**
 * State office cancels a certificate that should never have been issued.
 * The conditional update (only if still VALID) makes a double-click harmless.
 */
export async function revokeCertificate(user: AuthUser, certificateId: string, reason: string) {
  if (user.role !== "STATE") throw forbidden("Only the state office can cancel certificates");

  const cert = await prisma.$transaction(async (tx) => {
    const existing = await tx.certificate.findUnique({ where: { id: certificateId } });
    if (!existing) throw notFound("Certificate not found");
    const { count } = await tx.certificate.updateMany({
      where: { id: certificateId, status: "VALID" },
      data: { status: "REVOKED", revokedAt: new Date(), revokedById: user.id, revokeReason: reason },
    });
    if (count === 0) throw conflict("This certificate is already cancelled");
    await audit(tx, {
      entityType: "certificate", entityId: certificateId, batchId: existing.batchId, action: "CERTIFICATE_REVOKED",
      actorId: user.id, details: { number: existing.number, reason },
    });
    return tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, include: { batch: { include: { centre: true } } } });
  });

  await publish({
    type: "certificate.updated",
    rooms: batchAudience({ centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId }),
    payload: { certificateId: cert.id, batchId: cert.batchId, status: "REVOKED" },
  });
  return { id: cert.id, number: cert.number, status: cert.status, revokedAt: cert.revokedAt };
}
