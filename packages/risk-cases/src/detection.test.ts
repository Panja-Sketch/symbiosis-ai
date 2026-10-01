import { describe, expect, it } from "vitest";
import type { CaseSeverity, RiskImprovementCase } from "@symbiosis/contracts";
import { sampleAssessment } from "@symbiosis/verification/testing";
import { applyCaseCommand, createRiskImprovementCase } from "./index";
import type { CaseCommand } from "./index";

const T = (n: number) => `2026-01-02T00:${String(n).padStart(2, "0")}:00Z`;

function newCase(severity: CaseSeverity = "MODERATE"): RiskImprovementCase {
  const r = createRiskImprovementCase({
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    origin: { type: "DETECTED_HAZARD", detectionId: "DET-0" },
    hazardType: "H",
    title: "t",
    severity,
    activeRiskEventId: "EVT-1",
    createdAt: "2026-01-01T00:00:00Z",
  });
  if (!r.ok) throw new Error("fixture");
  return r.value;
}

function step(c: RiskImprovementCase, command: CaseCommand): RiskImprovementCase {
  const r = applyCaseCommand(c, command);
  if (!r.ok) throw new Error(r.error.code);
  return r.value.value;
}

const detect = (severity: CaseSeverity, n = 2): CaseCommand => ({
  type: "RECORD_DETECTION",
  at: T(n),
  detectionId: `DET-${n}`,
  severity,
});

describe("RECORD_DETECTION (S3: continuing detection of the same hazard)", () => {
  it("keeps the state, updates updatedAt, and records a same-state transition", () => {
    const r = applyCaseCommand(newCase(), detect("HIGH"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toMatchObject({ state: "OPEN", severity: "HIGH", updatedAt: T(2) });
      expect(r.value.record).toMatchObject({
        from: "OPEN",
        to: "OPEN",
        command: "RECORD_DETECTION",
      });
      expect(r.value.value.recurrenceCount).toBe(0);
    }
  });

  it("can raise severity but never lower it", () => {
    const high = newCase("HIGH");
    expect(step(high, detect("MODERATE", 2)).severity).toBe("HIGH");
    expect(step(high, detect("CRITICAL", 3)).severity).toBe("CRITICAL");
  });

  it("never verifies, closes or otherwise changes lifecycle state", () => {
    const required = step(newCase(), { type: "REQUIRE_ACTION", at: T(1) });
    const after = step(required, detect("CRITICAL", 5));
    expect(after.state).toBe("ACTION_REQUIRED");
    expect(after.latestVerificationId).toBeUndefined();
  });

  it("is recorded while the case waits in ACTION_REPORTED, with the state preserved (S4)", () => {
    let c = step(newCase(), { type: "REQUIRE_ACTION", at: T(1) });
    c = step(c, { type: "REPORT_ACTION", at: T(2), actionId: "ACT-1" });
    const after = step(c, detect("HIGH", 9));
    expect(after.state).toBe("ACTION_REPORTED");
    expect(after.severity).toBe("HIGH");
    expect(after.latestVerificationId).toBeUndefined();
  });

  it("is rejected in verification states, which belong to S5", () => {
    let c = step(newCase(), { type: "REQUIRE_ACTION", at: T(1) });
    c = step(c, { type: "REPORT_ACTION", at: T(2), actionId: "ACT-1" });
    c = step(c, { type: "START_VERIFICATION", at: T(3) });
    const verifying = applyCaseCommand(c, detect("HIGH", 9));
    expect(verifying.ok).toBe(false);
    if (!verifying.ok) expect(verifying.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");

    c = step(c, {
      type: "RECORD_VERIFICATION",
      at: T(4),
      assessment: sampleAssessment({ eventId: "EVT-1" }),
    });
    expect(c.state).toBe("VERIFIED_IMPROVED");
    expect(applyCaseCommand(c, detect("HIGH", 9)).ok).toBe(false);
  });

  it("validates its input and does not allow timestamps to regress", () => {
    const empty = { ...detect("HIGH"), detectionId: "" } as CaseCommand;
    const bad = { ...detect("HIGH"), severity: "SEVERE" } as unknown as CaseCommand;
    expect(applyCaseCommand(newCase(), empty).ok).toBe(false);
    expect(applyCaseCommand(newCase(), bad).ok).toBe(false);
    const later = step(newCase(), { type: "REQUIRE_ACTION", at: T(10) });
    expect(applyCaseCommand(later, detect("HIGH", 5)).ok).toBe(false);
  });

  it("is deterministic and does not mutate its input", () => {
    const c = newCase();
    expect(applyCaseCommand(c, detect("HIGH"))).toEqual(applyCaseCommand(c, detect("HIGH")));
    expect(c.severity).toBe("MODERATE");
  });
});
