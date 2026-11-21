import { Router } from "express";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../db.js";
import { authenticate, currentUser, requireRole } from "../auth/middleware.js";
import { config } from "../config.js";
import { notFound, param } from "../errors.js";
import { rateLimit } from "../rateLimit.js";
import { CERTIFICATE_NUMBER_RE, safeEqual } from "./ids.js";
import { certificateFilePath } from "./pdf.js";
import { listCertificates, revokeCertificate, verifyCertificate } from "./service.js";

// ---------------------------------------------------------------- public (no login)

export const publicRouter = Router();

publicRouter.get("/verify/:number", rateLimit("verify", config.verifyRateLimitPerMinute), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await verifyCertificate(param(req, "number")));
});

/**
 * The candidate's private download link (sent on WhatsApp):
 *   /api/certificates/:number/download?token=...
 * The number alone is NOT enough (it is printed on the certificate and shown to
 * employers); the 256-bit token is also required. Every failure is the same 404.
 */
publicRouter.get("/certificates/:number/download", rateLimit("download", 30), async (req, res) => {
  const number = param(req, "number").toUpperCase();
  const token = typeof req.query["token"] === "string" ? req.query["token"] : "";
  if (!CERTIFICATE_NUMBER_RE.test(number) || !token) throw notFound("Certificate not found");

  const cert = await prisma.certificate.findUnique({ where: { number } });
  if (!cert || !safeEqual(cert.downloadToken, token)) throw notFound("Certificate not found");
  if (cert.status !== "VALID") {
    res.status(410).json({ error: "This certificate has been cancelled" });
    return;
  }
  const file = certificateFilePath(cert.number);
  const ready = cert.filePath !== null && (await stat(file).then(() => true, () => false));
  if (!ready) {
    res.status(202).json({ status: "generating", message: "Your certificate is being prepared. Try again in a minute." });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.download(file, `${cert.number}.pdf`);
});

// ---------------------------------------------------------------- state office

export const certificatesRouter = Router();
certificatesRouter.use(authenticate, requireRole("STATE"));

certificatesRouter.get("/", async (req, res) => {
  const search = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
  res.json(await listCertificates(currentUser(req), search));
});

const revokeSchema = z.object({ reason: z.string().trim().min(5, "Give a reason (at least 5 characters)").max(1000) });

certificatesRouter.post("/:id/revoke", async (req, res) => {
  const { reason } = revokeSchema.parse(req.body);
  const id = param(req, "id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Certificate not found");
  res.json(await revokeCertificate(currentUser(req), id, reason));
});
