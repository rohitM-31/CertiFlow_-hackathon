import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, currentUser, requireRole } from "../auth/middleware.js";
import { badRequest, param } from "../errors.js";
import { decide, getBatch, getTimeline, listBatches, listStuckBatches, resubmitBatch, uploadBatch } from "./service.js";

export const batchesRouter = Router();
batchesRouter.use(authenticate);

// The CSV is kept in memory only long enough to validate it; never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.csv$/i.test(file.originalname)) cb(null, true);
    else cb(badRequest("Only .csv files are accepted"));
  },
});

const uploadSchema = z.object({ courseName: z.string().trim().min(3, "Course name is required").max(120) });
const decisionSchema = z.object({
  type: z.enum(["APPROVE", "REJECT", "SEND_BACK"]),
  reason: z.string().trim().max(1000).optional(),
});

batchesRouter.get("/", async (req, res) => {
  res.json(await listBatches(currentUser(req)));
});

batchesRouter.get("/stuck", requireRole("STATE"), async (_req, res) => {
  res.json(await listStuckBatches());
});

/** Upload a CSV: validates it, creates the batch and sends it for approval in one step. */
batchesRouter.post("/", requireRole("CENTRE"), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest('Attach the CSV as form field "file"');
  const { courseName } = uploadSchema.parse(req.body);
  res.status(201).json(await uploadBatch(currentUser(req), courseName, req.file));
});

batchesRouter.get("/:id", async (req, res) => {
  res.json(await getBatch(currentUser(req), param(req, "id")));
});

batchesRouter.get("/:id/timeline", async (req, res) => {
  res.json(await getTimeline(currentUser(req), param(req, "id")));
});

/** After a send-back: upload the corrected CSV; the batch re-enters review automatically. */
batchesRouter.post("/:id/resubmit", requireRole("CENTRE"), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest('Attach the corrected CSV as form field "file"');
  res.json(await resubmitBatch(currentUser(req), param(req, "id"), req.file));
});

batchesRouter.post("/:id/decisions", requireRole("DISTRICT_OFFICER", "QUALITY", "STATE"), async (req, res) => {
  const input = decisionSchema.parse(req.body);
  res.json(await decide(currentUser(req), param(req, "id"), input));
});
