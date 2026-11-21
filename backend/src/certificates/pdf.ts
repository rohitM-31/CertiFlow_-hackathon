import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { config } from "../config.js";
import { batchAudience, publish } from "../events.js";
import { enqueue, jobKeys } from "../queue.js";
import { log } from "../logger.js";
import { verifyUrl } from "./ids.js";

export function certificateFilePath(number: string): string {
  return path.resolve(config.storageDir, "certificates", `${number}.pdf`);
}

/**
 * Job "render-pdf": draw the certificate PDF with a QR code that links to the public
 * verification page, then queue the WhatsApp message.
 *
 * Idempotent and crash-safe: the PDF is written to a temp file and renamed into place
 * (rename is atomic), so a crash can never leave a half-written file that looks done.
 * Re-running overwrites with an identical file; the WhatsApp job key prevents a
 * second message.
 */
export async function renderCertificatePdf(certificateId: string): Promise<void> {
  const cert = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { candidate: true, batch: { include: { centre: { include: { district: true } } } } },
  });
  if (!cert) {
    log.warn("render-pdf: certificate not found", { certificateId });
    return;
  }
  if (cert.status !== "VALID") return; // never produce or send a cancelled certificate

  const finalPath = certificateFilePath(cert.number);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(finalPath), { recursive: true });

  const link = verifyUrl(config.publicBaseUrl, cert.number);
  const qr = await QRCode.toBuffer(link, { margin: 1, width: 220 });

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50 });
    const out = createWriteStream(tmpPath);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.on("error", reject);
    doc.pipe(out);

    const { width, height } = doc.page;
    doc.rect(20, 20, width - 40, height - 40).lineWidth(3).stroke("#1f4e79");
    doc.fillColor("#1f4e79").fontSize(14).text("PRAGATI SKILLS MISSION", 0, 60, { align: "center" });
    doc.fillColor("#000").fontSize(32).text("Certificate of Skill", 0, 90, { align: "center" });
    doc.fontSize(14).fillColor("#444").text("This is to certify that", 0, 160, { align: "center" });
    doc.fontSize(28).fillColor("#000").text(cert.candidate.fullName, 0, 190, { align: "center" });
    doc.fontSize(14).fillColor("#444").text("has successfully completed the course", 0, 240, { align: "center" });
    doc.fontSize(20).fillColor("#000").text(cert.batch.courseName, 0, 265, { align: "center" });
    doc.fontSize(12).fillColor("#444").text(`at ${cert.batch.centre.name}, ${cert.batch.centre.district.name}`, 0, 300, { align: "center" });

    doc.fontSize(11).fillColor("#000");
    doc.text(`Certificate No: ${cert.number}`, 70, height - 150);
    doc.text(`Enrolment No: ${cert.enrollmentNo}`, 70, height - 132);
    doc.text(`Issued on: ${cert.issuedAt.toISOString().slice(0, 10)}`, 70, height - 114);
    doc.fontSize(9).fillColor("#666").text(`Scan the QR code or visit ${link} to verify`, 70, height - 92);
    doc.image(qr, width - 200, height - 200, { width: 130 });
    doc.end();
  });

  await rename(tmpPath, finalPath);

  await prisma.$transaction(async (tx) => {
    await tx.certificate.update({ where: { id: cert.id }, data: { filePath: path.basename(finalPath) } });
    await audit(tx, { entityType: "certificate", entityId: cert.id, batchId: cert.batchId, action: "PDF_RENDERED", actorId: null });
    // One delivery record per certificate (UNIQUE), then the job that sends it.
    await tx.delivery.createMany({ data: [{ certificateId: cert.id, phone: cert.candidate.phone }], skipDuplicates: true });
    await enqueue(tx, "send-whatsapp", jobKeys.sendWhatsapp(cert.id), { certificateId: cert.id, batchId: cert.batchId });
  });
  await publish({
    type: "certificate.updated",
    rooms: batchAudience({ centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId }),
    payload: { certificateId: cert.id, batchId: cert.batchId, pdfReady: true },
  });
}
