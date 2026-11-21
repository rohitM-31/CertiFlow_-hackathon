/**
 * Background worker. Run as many as you like: each claims jobs from the Postgres job
 * table with SKIP LOCKED, so a job goes to exactly one worker, and a job held by a
 * worker that died is picked up again after its lock times out. All jobs are idempotent.
 *
 * Pipeline after the final approval:
 *   issue-batch ──► render-pdf (one per certificate, with QR code) ──► send-whatsapp (one per certificate)
 */
import os from "node:os";
import { claimJobs, completeJob, failJob, JOBS_CHANNEL, type ClaimedJob } from "./queue.js";
import { issueCertificatesForBatch } from "./certificates/issue.js";
import { renderCertificatePdf } from "./certificates/pdf.js";
import { markDeliveryFailed, sendCertificateWhatsapp } from "./whatsapp/sender.js";
import { sweep } from "./sweeper.js";
import { listen } from "./pgListen.js";
import { prisma } from "./db.js";
import { log } from "./logger.js";

const workerId = `${os.hostname()}-${process.pid}`;
const concurrency = Number(process.env["WORKER_CONCURRENCY"] ?? 5);
const POLL_MS = 1_000;
const SWEEP_MS = 60_000;

async function handle(job: ClaimedJob): Promise<void> {
  const certificateId = job.payload["certificateId"] ?? "";
  switch (job.name) {
    case "issue-batch":
      await issueCertificatesForBatch(job.payload["batchId"] ?? "");
      return;
    case "render-pdf":
      await renderCertificatePdf(certificateId);
      return;
    case "send-whatsapp":
      await sendCertificateWhatsapp(certificateId);
      return;
    default:
      throw new Error(`Unknown job type ${String(job.name)}`);
  }
}

async function runJob(job: ClaimedJob): Promise<void> {
  const started = Date.now();
  try {
    await handle(job);
    await completeJob(job, workerId);
    log.info("job done", { jobId: job.id, name: job.name, ...job.payload, attempt: job.attempts, ms: Date.now() - started });
  } catch (err) {
    const message = (err as Error).message;
    const outcome = await failJob(job, workerId, err);
    log.error("job failed", { jobId: job.id, name: job.name, ...job.payload, attempt: job.attempts, outcome, error: message });
    if (outcome === "failed" && job.name === "send-whatsapp") {
      await markDeliveryFailed(job.payload["certificateId"] ?? "", message);
    }
  }
}

// Idle workers sleep until a NOTIFY arrives (instant pickup) or the poll interval passes.
let wake: (() => void) | null = null;
const stopListening = listen(JOBS_CHANNEL, () => wake?.());

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

let running = true;
const inFlight = new Set<Promise<void>>();

/**
 * Keep up to `concurrency` jobs running at all times: as soon as one finishes, its slot
 * is refilled. (Waiting for a whole group would let one slow WhatsApp timeout hold up
 * every other slot.)
 */
async function loop(): Promise<void> {
  while (running) {
    const free = concurrency - inFlight.size;
    let jobs: ClaimedJob[] = [];
    if (free > 0) {
      try {
        jobs = await claimJobs(workerId, free);
      } catch (err) {
        log.error("could not claim jobs (database down?)", { error: (err as Error).message });
      }
    }
    for (const job of jobs) {
      const p: Promise<void> = runJob(job).finally(() => {
        inFlight.delete(p);
        wake?.(); // a slot is free: claim more right away
      });
      inFlight.add(p);
    }
    if (jobs.length === 0) {
      await sleep(POLL_MS); // woken early by a NOTIFY or a finished job
      wake = null;
    }
  }
  await Promise.all(inFlight); // shutting down: finish what we hold
}

const runSweep = () => sweep().catch((err) => log.error("sweep failed", { error: (err as Error).message }));
const sweepTimer = setInterval(runSweep, SWEEP_MS);
void runSweep();

log.info("worker started", { workerId, concurrency });
const finished = loop();

async function shutdown(signal: string) {
  log.info("worker shutting down", { signal });
  running = false; // finish the jobs in hand, claim no more
  wake?.();
  clearInterval(sweepTimer);
  await finished;
  await stopListening();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
