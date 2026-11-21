import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { errorHandler, notFound } from "./errors.js";
import { log } from "./logger.js";
import { prisma } from "./db.js";
import { authRouter } from "./auth/routes.js";
import { batchesRouter } from "./batches/routes.js";
import { certificatesRouter, publicRouter } from "./certificates/routes.js";
import { mockWhatsappRouter } from "./whatsapp/mockProvider.js";

/** Builds the Express app. Separate from index.ts so tests can use it without a server. */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind one reverse proxy: use its X-Forwarded-For for rate limits

  app.use(cors({ origin: config.frontendUrl }));
  app.use(express.json({ limit: "100kb" }));

  // Request ID: returned to the client and written to logs, to trace one request.
  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    req.requestId = typeof incoming === "string" && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const started = Date.now();
    res.on("finish", () => {
      log.info("request", { requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, userId: req.user?.id });
    });
    next();
  });

  app.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", publicRouter); // /api/verify/:number and the candidate's download link: no login
  app.use("/api/batches", batchesRouter);
  app.use("/api/certificates", certificatesRouter);

  // Stand-in WhatsApp provider + demo "phone inbox". Never in production.
  if (process.env["NODE_ENV"] !== "production") app.use("/mock-whatsapp", mockWhatsappRouter);

  app.use((_req, _res) => {
    throw notFound("No such endpoint");
  });
  app.use(errorHandler);
  return app;
}
