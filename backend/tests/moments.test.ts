/**
 * The "moments that must work" from the brief, end to end through the HTTP API
 * against a real Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { issueCertificatesForBatch } from "../src/certificates/issue.js";
import { escalateOverdueBatches } from "../src/sweeper.js";
import { jobKeys } from "../src/queue.js";
import { api, approve, approvedBatch, candidatesCsv, createWorld, uploadedBatch, type World } from "./helpers.js";

let world: World;
beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("Moment 1: a CSV with bad rows", () => {
  it("reports exactly what is wrong and creates nothing", async () => {
    const batchesBefore = await prisma.batch.count({ where: { centreId: world.centre.id } });
    const bad = [
      "enrollment_no,full_name,phone,date_of_birth",
      `${world.id}-T001,Asha Patil,9876543210,2000-05-04`,
      `${world.id}-T002,Ravi Kumar,12345,2000-05-04`,
      `${world.id}-T003,,9876543211,not-a-date`,
    ].join("\n");
    const res = await api(world.tokens.centre).uploadBatch(bad);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Nothing was saved/);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, field: "phone" }),
        expect.objectContaining({ row: 4, field: "full_name" }),
        expect.objectContaining({ row: 4, field: "date_of_birth" }),
      ]),
    );
    // No batch, no candidates: nothing half-saved.
    expect(await prisma.batch.count({ where: { centreId: world.centre.id } })).toBe(batchesBefore);
    expect(await prisma.candidate.count({ where: { enrollmentNo: { startsWith: world.id.toUpperCase() } } })).toBe(0);
  });

  it("a valid CSV creates the batch and sends it for approval automatically", async () => {
    const res = await api(world.tokens.centre).uploadBatch(candidatesCsv(4), "Tailoring");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "DISTRICT_REVIEW", candidates: 4 });
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: res.body.id }, include: { _count: { select: { candidates: true, certificates: true } } } });
    expect(batch._count).toEqual({ candidates: 4, certificates: 0 }); // no certificates yet
  });

  it("only CSV files are accepted", async () => {
    const res = await api(world.tokens.centre).uploadBatch("whatever", "Tailoring", "batch.xlsx");
    expect(res.status).toBe(400);
  });
});

describe("Moment 2: two officers approve at the same moment", () => {
  it("the batch moves forward exactly once", async () => {
    const batchId = await uploadedBatch(world);
    const results = await Promise.all([
      approve(world.tokens.officer1, batchId),
      approve(world.tokens.officer2, batchId),
      approve(world.tokens.officer3, batchId),
    ]);
    // Two approvals are needed. Decisions are serialised by the row lock, so the third
    // officer arrives after the batch has already left the district stage.
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 403]);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("STATE_REVIEW");
    expect(await prisma.auditLog.count({ where: { batchId, action: "STATUS_CHANGED" } })).toBe(1);
  });

  it("the same officer double-clicking counts once", async () => {
    const batchId = await uploadedBatch(world);
    const results = await Promise.all([approve(world.tokens.officer1, batchId), approve(world.tokens.officer1, batchId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.decision.count({ where: { batchId } })).toBe(1);
  });
});

describe("Certificates only after ALL mandatory approvals", () => {
  it("no certificate exists until the state office gives final approval", async () => {
    const batchId = await uploadedBatch(world, 60); // large: district x2, quality, state
    const certs = () => prisma.certificate.count({ where: { batchId } });
    const issueJobs = () => prisma.job.count({ where: { key: jobKeys.issueBatch(batchId) } });

    await approve(world.tokens.officer1, batchId);
    await approve(world.tokens.officer2, batchId);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("QUALITY_REVIEW");
    await approve(world.tokens.quality, batchId);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("STATE_REVIEW");

    // Even a stray job run before final approval creates nothing.
    expect(await issueCertificatesForBatch(batchId)).toBe(0);
    expect(await certs()).toBe(0);
    expect(await issueJobs()).toBe(0);

    await approve(world.tokens.state, batchId);
    // The final approval and its certificate job were committed together.
    expect(await issueJobs()).toBe(1);
  });
});

describe("Moment 3: an approved batch of 60 gets exactly one certificate each", () => {
  it("issuance is idempotent even if the job runs twice at once", async () => {
    const batchId = await uploadedBatch(world, 60);
    for (const who of ["officer1", "officer2", "quality", "state"] as const) {
      expect((await approve(world.tokens[who], batchId)).status).toBe(200);
    }
    // Simulate a retried / duplicated job: two workers run issuance concurrently, then again.
    await Promise.all([issueCertificatesForBatch(batchId), issueCertificatesForBatch(batchId)]);
    await issueCertificatesForBatch(batchId);

    const certs = await prisma.certificate.findMany({ where: { batchId } });
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);
    expect(new Set(certs.map((c) => c.number)).size).toBe(60);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("ISSUED");
    // One PDF job per certificate (the WhatsApp pipeline is tested in pipeline.test.ts).
    expect(await prisma.job.count({ where: { key: { in: certs.map((c) => jobKeys.renderPdf(c.id)) } } })).toBe(60);
  });
});

describe("Moment 4: a cancelled certificate is reported invalid", () => {
  it("verification says REVOKED immediately after the state office cancels", async () => {
    const batchId = await approvedBatch(world);
    await issueCertificatesForBatch(batchId);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });

    expect((await api("").get(`/api/verify/${cert.number}`)).body).toMatchObject({ valid: true, status: "VALID" });
    const revoke = await api(world.tokens.state).post(`/api/certificates/${cert.id}/revoke`, { reason: "Fraudulent assessment" });
    expect(revoke.status).toBe(200);
    expect((await api("").get(`/api/verify/${cert.number}`)).body).toMatchObject({ valid: false, status: "REVOKED" });
  });
});

describe("Moment 5: a batch left too long with an officer", () => {
  it("is escalated automatically, exactly once", async () => {
    const batchId = await uploadedBatch(world);
    await prisma.batch.update({ where: { id: batchId }, data: { stageEnteredAt: new Date(Date.now() - 3 * 3_600_000) } });

    await escalateOverdueBatches();
    await escalateOverdueBatches(); // a second sweep must not escalate again

    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).escalatedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { batchId, action: "SLA_ESCALATED" } })).toBe(1);
    const stuck = await api(world.tokens.state).get("/api/batches/stuck");
    expect(stuck.body.map((b: { id: string }) => b.id)).toContain(batchId);
  });
});

describe("Moment 6: send back, fix the CSV, resubmit", () => {
  it("earlier approvals are reset: the new round needs fresh approvals", async () => {
    const batchId = await uploadedBatch(world);
    expect((await approve(world.tokens.officer1, batchId)).status).toBe(200);

    const sendBack = await api(world.tokens.officer2).post(`/api/batches/${batchId}/decisions`, { type: "SEND_BACK", reason: "Row 3 phone wrong" });
    expect(sendBack.body.status).toBe("SENT_BACK");

    const resubmit = await api(world.tokens.centre).resubmit(batchId, candidatesCsv(5));
    expect(resubmit.status).toBe(200);
    expect(resubmit.body).toMatchObject({ status: "DISTRICT_REVIEW", round: 2 });

    // officer1 approved in round 1; that no longer counts, so one new approval isn't enough.
    expect((await approve(world.tokens.officer3, batchId)).status).toBe(200);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("DISTRICT_REVIEW");
    expect((await approve(world.tokens.officer1, batchId)).status).toBe(200);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("STATE_REVIEW");
  });

  it("a reason is required to send back, and only sent-back batches can be resubmitted", async () => {
    const batchId = await uploadedBatch(world);
    expect((await api(world.tokens.officer1).post(`/api/batches/${batchId}/decisions`, { type: "SEND_BACK" })).status).toBe(400);
    expect((await api(world.tokens.centre).resubmit(batchId, candidatesCsv(2))).status).toBe(409);
  });
});
