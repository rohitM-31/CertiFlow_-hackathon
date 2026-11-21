/**
 * Job "send-whatsapp": deliver a certificate to the candidate's phone.
 *
 * Exactly one message per certificate, even though the provider is unreliable:
 *  1. One Delivery row per certificate (UNIQUE). Once it is SENT we never call again.
 *  2. Every call carries Idempotency-Key = certificate id. If the provider accepted the
 *     message but our request timed out, the retry returns the SAME message instead of
 *     sending a second one.
 *  3. Failures (503, timeouts, network errors) throw, so the job queue retries with
 *     exponential backoff. After the last attempt the delivery is marked FAILED and is
 *     visible to the state office.
 *  4. A certificate cancelled before delivery is never sent.
 */
import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { batchAudience, publish } from "../events.js";
import { downloadUrl, verifyUrl } from "../certificates/ids.js";

export interface SendOptions {
  baseUrl?: string; // provider URL (tests point this at a local server)
  timeoutMs?: number;
}

export async function sendCertificateWhatsapp(certificateId: string, opts: SendOptions = {}): Promise<"sent" | "skipped"> {
  const baseUrl = opts.baseUrl ?? config.whatsappApiUrl;
  const timeoutMs = opts.timeoutMs ?? config.whatsappTimeoutMs;

  const cert = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { candidate: true, batch: { include: { centre: true } }, delivery: true },
  });
  if (!cert || cert.status !== "VALID") return "skipped"; // never send a cancelled certificate
  if (cert.delivery?.status === "SENT") return "skipped"; // already delivered

  const delivery =
    cert.delivery ??
    (await prisma.delivery.upsert({
      where: { certificateId },
      create: { certificateId, phone: cert.candidate.phone },
      update: {},
    }));
  await prisma.delivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 } } });

  const firstName = cert.candidate.fullName.split(/\s+/)[0];
  const text =
    `Hello ${firstName}, congratulations! Your Pragati Skills Mission certificate for "${cert.batch.courseName}" is ready.\n` +
    `Certificate No: ${cert.number}\n` +
    `Download: ${downloadUrl(config.publicBaseUrl, cert.number, cert.downloadToken)}\n` +
    `Anyone can verify it at: ${verifyUrl(config.publicBaseUrl, cert.number)}`;

  let messageId: string;
  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": cert.id },
      body: JSON.stringify({ to: `+91${cert.candidate.phone}`, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`provider returned HTTP ${res.status}`);
    const body = (await res.json()) as { messageId?: unknown };
    if (typeof body.messageId !== "string") throw new Error("provider response has no messageId");
    messageId = body.messageId;
  } catch (err) {
    const message = (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (err as Error).message;
    await prisma.delivery.update({ where: { id: delivery.id }, data: { lastError: message } });
    throw new Error(`WhatsApp send failed: ${message}`); // the job queue retries with backoff
  }

  await prisma.$transaction(async (tx) => {
    await tx.delivery.update({
      where: { id: delivery.id },
      data: { status: "SENT", providerMessageId: messageId, sentAt: new Date(), lastError: null },
    });
    await audit(tx, {
      entityType: "certificate", entityId: cert.id, batchId: cert.batchId, action: "WHATSAPP_SENT", actorId: null,
      details: { providerMessageId: messageId, attempts: delivery.attempts + 1 },
    });
  });
  await publish({
    type: "certificate.updated",
    rooms: batchAudience({ centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId }),
    payload: { certificateId: cert.id, batchId: cert.batchId, whatsapp: "SENT" },
  });
  return "sent";
}

/** Called when the job has used up all its retries. */
export async function markDeliveryFailed(certificateId: string, reason: string): Promise<void> {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId }, select: { batchId: true } });
  if (!cert) return;
  await prisma.$transaction(async (tx) => {
    await tx.delivery.updateMany({ where: { certificateId, status: "PENDING" }, data: { status: "FAILED", lastError: reason } });
    await audit(tx, { entityType: "certificate", entityId: certificateId, batchId: cert.batchId, action: "WHATSAPP_FAILED", actorId: null, details: { reason } });
  });
}
