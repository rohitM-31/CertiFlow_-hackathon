/** "Things that must never happen", each proven by a test. */
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { issueCertificatesForBatch } from "../src/certificates/issue.js";
import { newDownloadToken } from "../src/certificates/ids.js";
import { api, app, approve, approvedBatch, candidatesCsv, createWorld, uploadedBatch, type World } from "./helpers.js";

let world: World;
beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function issuedCertificate() {
  const batchId = await approvedBatch(world, 1);
  await issueCertificatesForBatch(batchId);
  return prisma.certificate.findFirstOrThrow({ where: { batchId }, include: { candidate: true } });
}

describe("Never: someone acting at a step that is not theirs", () => {
  it("a centre cannot approve, and quality/state cannot skip the district stage", async () => {
    const batchId = await uploadedBatch(world);
    expect((await approve(world.tokens.centre, batchId)).status).toBe(403);
    expect((await approve(world.tokens.state, batchId)).status).toBe(403);
    expect((await approve(world.tokens.quality, batchId)).status).toBe(403);
    expect(await prisma.decision.count({ where: { batchId } })).toBe(0);
  });

  it("an officer from another district cannot see or decide on the batch", async () => {
    const batchId = await uploadedBatch(world);
    expect((await api(world.tokens.outsider).get(`/api/batches/${batchId}`)).status).toBe(404);
    expect((await approve(world.tokens.outsider, batchId)).status).toBe(404);
    const list = await api(world.tokens.outsider).get("/api/batches");
    expect(list.body.map((b: { id: string }) => b.id)).not.toContain(batchId);
  });

  it("only centres upload, and only the state office cancels certificates", async () => {
    expect((await api(world.tokens.officer1).uploadBatch(candidatesCsv(1))).status).toBe(403);
    const cert = await issuedCertificate();
    for (const who of ["centre", "officer1", "quality"] as const) {
      expect((await api(world.tokens[who]).post(`/api/certificates/${cert.id}/revoke`, { reason: "Trying my luck" })).status).toBe(403);
    }
  });
});

describe("Never: acting as someone else (tampered requests)", () => {
  it("rejects missing, forged and alg:none tokens", async () => {
    expect((await request(app).get("/api/batches")).status).toBe(401);
    const forged = jwt.sign({}, "not-the-real-secret", { subject: world.people.state.id });
    expect((await api(forged).get("/api/batches")).status).toBe(401);
    const unsigned = jwt.sign({}, "", { subject: world.people.state.id, algorithm: "none" });
    expect((await api(unsigned).get("/api/batches")).status).toBe(401);
  });

  it("ignores identity smuggled into the request body", async () => {
    const batchId = await uploadedBatch(world);
    const res = await api(world.tokens.centre).post(`/api/batches/${batchId}/decisions`, { type: "APPROVE", userId: world.people.officer1.id });
    expect(res.status).toBe(403);
  });
});

describe("Never: two certificates for one candidate, or two sharing a number", () => {
  it("the database refuses a second certificate for the same candidate", async () => {
    const cert = await issuedCertificate();
    await expect(
      prisma.certificate.create({
        data: { number: "PSM-ZZZZZZZZZZ", candidateId: cert.candidateId, enrollmentNo: `${cert.enrollmentNo}-X`, batchId: cert.batchId, downloadToken: newDownloadToken() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("the database refuses a duplicate certificate number", async () => {
    const a = await issuedCertificate();
    const b = await issuedCertificate();
    await expect(prisma.certificate.update({ where: { id: b.id }, data: { number: a.number } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("the same enrolment cannot be uploaded in two active batches", async () => {
    const csv = candidatesCsv(2);
    expect((await api(world.tokens.centre).uploadBatch(csv)).status).toBe(201);
    const again = await api(world.tokens.centre).uploadBatch(csv);
    expect(again.status).toBe(422);
    expect(again.body.details[0].message).toMatch(/already in batch/);
  });
});

describe("Never: a stranger getting someone else's certificate or personal details", () => {
  it("public verification shows no phone, date of birth or enrolment number, and masks the name", async () => {
    const cert = await issuedCertificate();
    const res = await request(app).get(`/api/verify/${cert.number}`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(cert.candidate.phone);
    expect(text).not.toContain(cert.enrollmentNo);
    expect(text).not.toContain(cert.candidate.dateOfBirth.toISOString().slice(0, 10));
    expect(res.body.holderName).not.toBe(cert.candidate.fullName);
  });

  it("the PDF download needs the secret token, not just the (public) number", async () => {
    const cert = await issuedCertificate();
    expect((await request(app).get(`/api/certificates/${cert.number}/download`)).status).toBe(404);
    expect((await request(app).get(`/api/certificates/${cert.number}/download?token=guess`)).status).toBe(404);
    const ok = await request(app).get(`/api/certificates/${cert.number}/download?token=${cert.downloadToken}`);
    expect([200, 202]).toContain(ok.status); // 202 = PDF still rendering; never 404
  });

  it("a centre cannot see another centre's batches", async () => {
    const other = await createWorld();
    const batchId = await uploadedBatch(other);
    expect((await api(world.tokens.centre).get(`/api/batches/${batchId}`)).status).toBe(404);
  });
});

describe("Never: a decision that cannot be traced", () => {
  it("every decision is in the audit log with who and when", async () => {
    const batchId = await uploadedBatch(world);
    await approve(world.tokens.officer1, batchId);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { batchId, action: "DECISION_APPROVE" } });
    expect(entry.actorId).toBe(world.people.officer1.id);
    expect(entry.createdAt).toBeInstanceOf(Date);
    const timeline = await api(world.tokens.officer1).get(`/api/batches/${batchId}/timeline`);
    expect(timeline.body.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["BATCH_UPLOADED", "SENT_FOR_APPROVAL", "DECISION_APPROVE"]),
    );
  });

  it("the audit log cannot be edited or deleted, even directly in the database", async () => {
    const batchId = await uploadedBatch(world);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { batchId } });
    await expect(prisma.auditLog.update({ where: { id: entry.id }, data: { action: "TAMPERED" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});

describe("Bad input cannot fool the system", () => {
  it("rejects junk ids and bad decision types cleanly", async () => {
    expect((await api(world.tokens.officer1).get("/api/batches/'; DROP TABLE \"Batch\";--")).status).toBe(404);
    const batchId = await uploadedBatch(world);
    expect((await api(world.tokens.officer1).post(`/api/batches/${batchId}/decisions`, { type: "APPROVE_ALL" })).status).toBe(400);
  });
});
