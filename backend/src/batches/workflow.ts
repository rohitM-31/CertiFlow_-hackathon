/**
 * The approval workflow as pure functions (no database), so the rules are easy to
 * read and unit-test.
 *
 *  CSV upload (valid) ──► DISTRICT_REVIEW ──(2 officer approvals)──► QUALITY_REVIEW (> 50 candidates only)
 *                              │                                          │ approve
 *                        send back / reject                               ▼
 *  corrected CSV ◄── SENT_BACK ◄── (any review stage) ──────────────► STATE_REVIEW ──approve──► APPROVED
 *      │                                                                                     │ (automatic)
 *      └──► DISTRICT_REVIEW, new round (earlier approvals no longer count)                   ▼
 *                                                                       certificates + PDFs + QR + WhatsApp
 *  REJECTED is final. Certificates are NEVER created before APPROVED.
 */
import type { BatchStatus, DecisionType, Role, Stage } from "../generated/prisma/enums.js";
import type { AuthUser } from "../auth/middleware.js";
import { conflict, forbidden, notFound } from "../errors.js";

export const REVIEW_STATUSES: readonly BatchStatus[] = ["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"];

const STAGE_FOR_STATUS: Partial<Record<BatchStatus, Stage>> = {
  DISTRICT_REVIEW: "DISTRICT",
  QUALITY_REVIEW: "QUALITY",
  STATE_REVIEW: "STATE",
};

/** Which role decides at each stage. */
export const ROLE_FOR_STAGE: Record<Stage, Role> = {
  DISTRICT: "DISTRICT_OFFICER",
  QUALITY: "QUALITY",
  STATE: "STATE",
};

export function stageForStatus(status: BatchStatus): Stage | null {
  return STAGE_FOR_STATUS[status] ?? null;
}

export interface ApprovalRules {
  districtApprovalsRequired: number;
  largeBatchThreshold: number;
}

/**
 * After an APPROVE vote is recorded, where does the batch go?
 * null = it stays (e.g. still waiting for the second district officer).
 */
export function nextStatusAfterApproval(
  stage: Stage,
  approvalsAtStage: number,
  candidateCount: number,
  rules: ApprovalRules,
): BatchStatus | null {
  switch (stage) {
    case "DISTRICT":
      if (approvalsAtStage < rules.districtApprovalsRequired) return null;
      return candidateCount > rules.largeBatchThreshold ? "QUALITY_REVIEW" : "STATE_REVIEW";
    case "QUALITY":
      return "STATE_REVIEW";
    case "STATE":
      return "APPROVED";
  }
}

/** One SEND_BACK or REJECT is enough to stop a batch (approval needs agreement; objection doesn't). */
export function nextStatusAfterObjection(type: Exclude<DecisionType, "APPROVE">): BatchStatus {
  return type === "SEND_BACK" ? "SENT_BACK" : "REJECTED";
}

interface BatchForAccess {
  centreId: string;
  centre: { districtId: string };
}

/** Can this user see this batch at all? */
export function canViewBatch(user: AuthUser, batch: BatchForAccess): boolean {
  switch (user.role) {
    case "CENTRE":
      return batch.centreId === user.centreId;
    case "DISTRICT_OFFICER":
      return batch.centre.districtId === user.districtId;
    case "QUALITY":
    case "STATE":
      return true; // state-wide teams
  }
}

/** Is it this user's turn to decide? Returns the stage, or throws the right HTTP error. */
export function assertCanDecide(user: AuthUser, batch: BatchForAccess & { status: BatchStatus }): Stage {
  if (!canViewBatch(user, batch)) throw notFound("Batch not found");
  const stage = stageForStatus(batch.status);
  if (!stage) throw conflict(`This batch is not waiting for a decision (it is ${batch.status})`);
  if (user.role !== ROLE_FOR_STAGE[stage]) {
    throw forbidden(`Only ${ROLE_FOR_STAGE[stage]} users can decide at the ${stage} stage`);
  }
  return stage;
}
