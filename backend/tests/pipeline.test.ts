/**
 * The automatic pipeline after final approval:
 *   certificates -> PDF with QR code -> WhatsApp (unreliable provider)
 * and the job queue it runs on.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { issueCertificatesForBatch } from "../src/certificates/issue.js";
import { renderCertificatePdf } from "../src/certificates/pdf.js";
import { sendCertificateWhatsapp } from "../src/whatsapp/sender.js";
import { mockWhatsapp } from "../src/whatsapp/mockProvider.js";
import { claimJobs, enqueue, failJob, jobKeys } from "../src/queue.js";
import { api, app, approve, approvedBatch, createWorld, uploadedBatch, type World } from "./helpers.js";

let world: World;
let server: Server;
let providerUrl: string;

beforeAll(async () => {
  world = await createWorld();
  // Run the app on a real port so the sender talks to the stand-in provider over HTTP.
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mock-whatsapp`;
});
afterAll(async () => {
  server.closeAllConnections(); // drop responses the mock is deliberately "hanging"
  server.close();
  await prisma.$disconnect();
});
beforeEach(() => mockWhatsapp.reset());

/** Retry like the job queue would (without the backoff delays). */
async function sendWithRetries(certificateId: string, attempts = 50) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendCertificateWhatsapp(certificateId, { baseUrl: providerUrl, timeoutMs: 300 });
    } catch {
      if (i === attempts) throw new Error("gave up");
    }
  }
}

const phoneOf = async (certificateId: string) =>
  `+91${(await prisma.certificate.findUniqueOrThrow({ where: { id: certificateId }, include: { candidate: true } })).candidate.phone}`;

describe("PDF with QR code", () => {
  it("renders the PDF and queues exactly one WhatsApp job", async () => {
    const batchId = await approvedBatch(world, 1);
    await issueCertificatesForBatch(batchId);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });

    await renderCertificatePdf(cert.id);
    await renderCertificatePdf(cert.id); // re-run (e.g. retried job) is harmless

    const after = await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id }, include: { delivery: true } });
    expect(after.filePath).toBe(`${cert.number}.pdf`);
    expect(after.delivery?.status).toBe("PENDING");
    expect(await prisma.job.count({ where: { key: jobKeys.sendWhatsapp(cert.id) } })).toBe(1);

    const download = await api("").get(`/api/certificates/${cert.number}/download?token=${cert.downloadToken}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toMatch(/pdf/);
  });
});

describe("Moment 3: every candidate gets exactly one certificate on their phone", () => {
  it("60 candidates, unreliable provider (failures + timeouts): one message each", async () => {
    const batchId = await uploadedBatch(world, 60);
    for (const who of ["officer1", "officer2", "quality", "state"] as const) await approve(world.tokens[who], batchId);
    await issueCertificatesForBatch(batchId);
    const certs = await prisma.certificate.findMany({ where: { batchId } });
    for (const c of certs) await renderCertificatePdf(c.id);

    // Make the provider misbehave a lot: outages AND "accepted but timed out".
    mockWhatsapp.forceNext(...Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "fail" : "timeout") as "fail" | "timeout"));
    for (const c of certs) await sendWithRetries(c.id);

    const inbox = mockWhatsapp.inbox();
    expect(inbox).toHaveLength(60);
    for (const c of certs) {
      expect(mockWhatsapp.inbox(await phoneOf(c.id))).toHaveLength(1);
    }
    expect(await prisma.delivery.count({ where: { certificateId: { in: certs.map((c) => c.id) }, status: "SENT" } })).toBe(60);
  });

  it("a timeout after the provider accepted does not cause a second message", async () => {
    const batchId = await approvedBatch(world, 1);
    await issueCertificatesForBatch(batchId);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    await renderCertificatePdf(cert.id);

    mockWhatsapp.forceNext("timeout"); // delivered, but we never hear back
    await expect(sendCertificateWhatsapp(cert.id, { baseUrl: providerUrl, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(mockWhatsapp.inbox()).toHaveLength(1);

    // The retry uses the same idempotency key: provider returns the original message.
    expect(await sendCertificateWhatsapp(cert.id, { baseUrl: providerUrl, timeoutMs: 300 })).toBe("sent");
    expect(mockWhatsapp.inbox()).toHaveLength(1);
    // And once SENT, we never call the provider again.
    expect(await sendCertificateWhatsapp(cert.id, { baseUrl: providerUrl })).toBe("skipped");

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { certificateId: cert.id } });
    expect(delivery).toMatchObject({ status: "SENT", attempts: 2 });
    expect(delivery.providerMessageId).toBe(mockWhatsapp.inbox()[0]?.id);
  });

  it("a certificate cancelled before delivery is never sent", async () => {
    const batchId = await approvedBatch(world, 1);
    await issueCertificatesForBatch(batchId);
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId } });
    await renderCertificatePdf(cert.id);
    await api(world.tokens.state).post(`/api/certificates/${cert.id}/revoke`, { reason: "Issued in error" });

    expect(await sendCertificateWhatsapp(cert.id, { baseUrl: providerUrl })).toBe("skipped");
    expect(mockWhatsapp.inbox()).toHaveLength(0);
  });
});

describe("Job queue (Postgres, SKIP LOCKED)", () => {
  it("enqueueing the same key twice creates one job", async () => {
    const key = `test:${world.id}:dup`;
    await prisma.$transaction((tx) => enqueue(tx, "render-pdf", key, { certificateId: "x" }));
    await prisma.$transaction((tx) => enqueue(tx, "render-pdf", key, { certificateId: "x" }));
    expect(await prisma.job.count({ where: { key } })).toBe(1);
  });

  it("a job enqueued in a rolled-back transaction never exists", async () => {
    const key = `test:${world.id}:rollback`;
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue(tx, "render-pdf", key, { certificateId: "x" });
        throw new Error("approval failed");
      }),
    ).rejects.toThrow();
    expect(await prisma.job.count({ where: { key } })).toBe(0);
  });

  it("two workers claiming at once never get the same job", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `test:${world.id}:claim:${i}`);
    // Very old runAt so these are first in line, ahead of any other pending jobs.
    await prisma.job.createMany({ data: keys.map((key) => ({ key, name: "render-pdf", payload: {}, runAt: new Date("2000-01-01") })) });

    const [a, b] = await Promise.all([claimJobs("worker-a", 5), claimJobs("worker-b", 5)]);
    const idsA = new Set(a.map((j) => j.id));
    expect(b.some((j) => idsA.has(j.id))).toBe(false);

    const mine = await prisma.job.findMany({ where: { key: { in: keys } } });
    expect(mine.every((j) => j.status === "RUNNING")).toBe(true);
    expect(new Set(mine.map((j) => j.lockedBy))).toEqual(new Set(["worker-a", "worker-b"]));
  });

  it("failed jobs retry with backoff, then give up after maxAttempts", async () => {
    const key = `test:${world.id}:retry`;
    await prisma.job.create({ data: { key, name: "send-whatsapp", payload: {}, maxAttempts: 2, runAt: new Date("2000-01-01") } });
    const { id } = await prisma.job.findUniqueOrThrow({ where: { key } });
    const claimMine = async () => (await claimJobs("w", 50)).find((j) => j.id === id);

    const first = await claimMine();
    expect(first).toBeDefined();
    expect(await failJob(first!, "w", new Error("provider 503"))).toBe("retry");
    const retrying = await prisma.job.findUniqueOrThrow({ where: { key } });
    expect(retrying.status).toBe("PENDING");
    expect(retrying.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off into the future

    await prisma.job.update({ where: { key }, data: { runAt: new Date("2000-01-01") } }); // skip the wait
    const second = await claimMine();
    expect(await failJob(second!, "w", new Error("provider 503"))).toBe("failed");
    expect((await prisma.job.findUniqueOrThrow({ where: { key } })).status).toBe("FAILED");
  });
});
