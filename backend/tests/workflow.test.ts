// The approval rules and "who may act at which step", without a database.
import { describe, expect, it } from "vitest";
import type { AuthUser } from "../src/auth/middleware.js";
import { assertCanDecide, canViewBatch, nextStatusAfterApproval, nextStatusAfterObjection } from "../src/batches/workflow.js";
import { maskName } from "../src/certificates/ids.js";

const rules = { districtApprovalsRequired: 2, largeBatchThreshold: 50 };

const user = (role: AuthUser["role"], extra: Partial<AuthUser> = {}): AuthUser => ({
  id: `u-${role}`, username: role, name: role, role, districtId: null, centreId: null, ...extra,
});
const puneBatch = (status: "DISTRICT_REVIEW" | "QUALITY_REVIEW" | "STATE_REVIEW" | "SENT_BACK" | "APPROVED") => ({
  status, centreId: "centre-pune", centre: { districtId: "pune" },
});

describe("nextStatusAfterApproval", () => {
  it("needs two district approvals", () => {
    expect(nextStatusAfterApproval("DISTRICT", 1, 10, rules)).toBeNull();
    expect(nextStatusAfterApproval("DISTRICT", 2, 10, rules)).toBe("STATE_REVIEW");
  });
  it("sends large batches to the quality team", () => {
    expect(nextStatusAfterApproval("DISTRICT", 2, 50, rules)).toBe("STATE_REVIEW");
    expect(nextStatusAfterApproval("DISTRICT", 2, 51, rules)).toBe("QUALITY_REVIEW");
  });
  it("quality goes to state; state gives the final approval", () => {
    expect(nextStatusAfterApproval("QUALITY", 1, 60, rules)).toBe("STATE_REVIEW");
    expect(nextStatusAfterApproval("STATE", 1, 60, rules)).toBe("APPROVED");
  });
  it("one objection is enough to stop a batch", () => {
    expect(nextStatusAfterObjection("SEND_BACK")).toBe("SENT_BACK");
    expect(nextStatusAfterObjection("REJECT")).toBe("REJECTED");
  });
});

describe("who may act at which step", () => {
  const officer = user("DISTRICT_OFFICER", { districtId: "pune" });
  const otherDistrictOfficer = user("DISTRICT_OFFICER", { districtId: "nashik" });

  it("district officers decide only at the district stage, in their own district", () => {
    expect(assertCanDecide(officer, puneBatch("DISTRICT_REVIEW"))).toBe("DISTRICT");
    expect(() => assertCanDecide(officer, puneBatch("STATE_REVIEW"))).toThrow(/Only STATE/);
    expect(() => assertCanDecide(otherDistrictOfficer, puneBatch("DISTRICT_REVIEW"))).toThrow(/not found/i);
  });

  it("quality and state cannot jump the queue", () => {
    expect(() => assertCanDecide(user("STATE"), puneBatch("DISTRICT_REVIEW"))).toThrow(/Only DISTRICT_OFFICER/);
    expect(() => assertCanDecide(user("QUALITY"), puneBatch("STATE_REVIEW"))).toThrow(/Only STATE/);
    expect(assertCanDecide(user("QUALITY"), puneBatch("QUALITY_REVIEW"))).toBe("QUALITY");
  });

  it("nobody decides on a batch that isn't under review", () => {
    expect(() => assertCanDecide(user("STATE"), puneBatch("SENT_BACK"))).toThrow(/not waiting/);
    expect(() => assertCanDecide(user("STATE"), puneBatch("APPROVED"))).toThrow(/not waiting/);
  });

  it("centres see only their own batches", () => {
    expect(canViewBatch(user("CENTRE", { centreId: "centre-pune" }), puneBatch("SENT_BACK"))).toBe(true);
    expect(canViewBatch(user("CENTRE", { centreId: "centre-other" }), puneBatch("SENT_BACK"))).toBe(false);
  });
});

describe("maskName", () => {
  it("shows first name and initials only", () => {
    expect(maskName("Rahul Kumar Sharma")).toBe("Rahul K. S.");
    expect(maskName("Asha")).toBe("Asha");
  });
});
