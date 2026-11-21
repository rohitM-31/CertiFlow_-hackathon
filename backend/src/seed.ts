/**
 * Demo data. Safe to run repeatedly: does nothing if the demo users already exist.
 *
 * Everyone's password is "demo123".
 *   anika              training centre (Pune)
 *   dev, meera, kabir  district officers (Pune)
 *   neha               quality team
 *   farah              state office
 */
import bcrypt from "bcrypt";
import { prisma } from "./db.js";
import { newCertificateNumber, newDownloadToken } from "./certificates/ids.js";
import { enqueue, jobKeys } from "./queue.js";

const FIRST = ["Aarav", "Diya", "Vihaan", "Ananya", "Arjun", "Isha", "Kabir", "Saanvi", "Rohan", "Meera", "Aditya", "Priya", "Karan", "Neha", "Rahul", "Pooja", "Siddharth", "Kavya", "Yash", "Sneha"];
const LAST = ["Sharma", "Patil", "Deshmukh", "Kulkarni", "Joshi", "Shinde", "Pawar", "Jadhav", "More", "Gaikwad"];

function candidates(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    enrollmentNo: `${prefix}-${String(i + 1).padStart(4, "0")}`,
    fullName: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    phone: `98${String(20000000 + i * 7919).padStart(8, "0")}`,
    dateOfBirth: new Date(Date.UTC(1998 + (i % 8), i % 12, 1 + (i % 27))),
  }));
}

async function main() {
  if (await prisma.user.findUnique({ where: { username: "anika" } })) {
    console.log("Seed: demo data already present, skipping.");
    return;
  }
  const passwordHash = await bcrypt.hash("demo123", 10);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  const pune = await prisma.district.create({ data: { name: "Pune" } });
  const nashik = await prisma.district.create({ data: { name: "Nashik" } });
  const centre = await prisma.centre.create({ data: { code: "PSC-PUN-01", name: "Pragati Skills Centre, Hadapsar", districtId: pune.id } });
  // A second district, to show officers only see their own district's batches.
  const nashikCentre = await prisma.centre.create({ data: { code: "PSC-NSK-01", name: "Pragati Skills Centre, Nashik Road", districtId: nashik.id } });

  const mk = (username: string, name: string, role: "CENTRE" | "DISTRICT_OFFICER" | "QUALITY" | "STATE", extra = {}) =>
    prisma.user.create({ data: { username, name, role, passwordHash, ...extra } });
  const anika = await mk("anika", "Anika (Training Centre)", "CENTRE", { centreId: centre.id });
  const dev = await mk("dev", "Dev (District Officer)", "DISTRICT_OFFICER", { districtId: pune.id });
  await mk("meera", "Meera (District Officer)", "DISTRICT_OFFICER", { districtId: pune.id });
  await mk("kabir", "Kabir (District Officer)", "DISTRICT_OFFICER", { districtId: pune.id });
  await mk("neha", "Neha (Quality Team)", "QUALITY");
  const farah = await mk("farah", "Farah (State Office)", "STATE");

  const log = (batchId: string, action: string, actorId: string | null, details?: object) =>
    prisma.auditLog.create({ data: { entityType: "batch", entityId: batchId, batchId, action, actorId, ...(details ? { details } : {}) } });
  const batch = async (courseName: string, prefix: string, count: number, extra: object, centreId = centre.id) => {
    const b = await prisma.batch.create({
      data: { courseName, centreId, sourceFile: `${prefix.toLowerCase()}.csv`, candidates: { create: candidates(prefix, count) }, ...extra },
      include: { candidates: { orderBy: { enrollmentNo: "asc" } } },
    });
    await log(b.id, "BATCH_UPLOADED", anika.id, { file: b.sourceFile, candidates: count });
    return b;
  };

  // 1. District review with ONE approval (Dev): the next officer's approval moves it on.
  const retail = await batch("Retail Sales Associate", "RSA26", 12, { stageEnteredAt: hoursAgo(0.2) });
  await prisma.decision.create({ data: { batchId: retail.id, round: 1, stage: "DISTRICT", type: "APPROVE", userId: dev.id } });
  await log(retail.id, "DECISION_APPROVE", dev.id, { stage: "DISTRICT", round: 1 });

  // 2. Large batch (60): after two district approvals it goes to the quality team.
  await batch("Data Entry Operator", "DEO26", 60, { stageEnteredAt: hoursAgo(0.1) });

  // 3. Waiting at the state office for 3 hours: past the SLA, so the worker escalates it.
  await batch("Beauty Therapist", "BTY26", 10, { status: "STATE_REVIEW", stageEnteredAt: hoursAgo(3) });

  // 4. Sent back by Meera's colleague: Anika can upload a corrected CSV.
  await batch("Electrician - Domestic", "ELE26", 8, {
    status: "SENT_BACK", stageEnteredAt: hoursAgo(1), lastReason: "Row 4: phone number belongs to the trainer, not the candidate",
  });

  // 5. Already issued, with two known numbers for the verify demo:
  //    PSM-DEMO000001 (valid) and PSM-DEMO000002 (cancelled). PDF jobs are queued, so the
  //    worker renders them and sends the WhatsApp messages as soon as it starts.
  const issued = await batch("Welding Technician", "WLD26", 5, { status: "ISSUED" });
  for (const [i, c] of issued.candidates.entries()) {
    const number = i === 0 ? "PSM-DEMO000001" : i === 1 ? "PSM-DEMO000002" : newCertificateNumber();
    const revoked = i === 1;
    const cert = await prisma.certificate.create({
      data: {
        number, candidateId: c.id, enrollmentNo: c.enrollmentNo, batchId: issued.id, downloadToken: newDownloadToken(), issuedAt: hoursAgo(48),
        ...(revoked ? { status: "REVOKED" as const, revokedAt: hoursAgo(24), revokedById: farah.id, revokeReason: "Candidate did not attend the assessment" } : {}),
      },
    });
    await prisma.auditLog.create({
      data: { entityType: "certificate", entityId: cert.id, batchId: issued.id, action: revoked ? "CERTIFICATE_REVOKED" : "CERTIFICATE_ISSUED", actorId: revoked ? farah.id : null, details: { number } },
    });
    if (!revoked) await prisma.$transaction((tx) => enqueue(tx, "render-pdf", jobKeys.renderPdf(cert.id), { certificateId: cert.id, batchId: issued.id }));
  }

  // 6. A Nashik batch: Pune officers must NOT see it.
  await batch("Plumbing", "PLB26", 6, { stageEnteredAt: hoursAgo(0.5) }, nashikCentre.id);

  console.log("Seed: demo data created. Password for every demo user: demo123");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
