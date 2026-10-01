import { describe, expect, it } from "vitest";
import type { RiskRecommendation } from "@symbiosis/contracts";
import { RECOMMENDATION_STATUSES } from "@symbiosis/contracts";
import { sampleAssessment } from "@symbiosis/verification/testing";
import {
  RECOMMENDATION_TRANSITIONS,
  applyRecommendationCommand,
  createRiskRecommendation,
  isRecommendationVerified,
} from "./index";
import type { RecommendationCommand } from "./index";

const T = "2026-01-02T00:00:00Z";

function make(): RiskRecommendation {
  const r = createRiskRecommendation({
    recommendationId: "REC-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    source: "INSURER",
    hazardType: "COOLING_FAN_DEGRADATION",
    description: "Service primary fan assembly",
    approvedActionIds: ["RA-1"],
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function step(r: RiskRecommendation, c: RecommendationCommand): RiskRecommendation {
  const out = applyRecommendationCommand(r, c);
  if (!out.ok) throw new Error(`unexpected ${out.error.code}`);
  return out.value.value;
}

describe("createRiskRecommendation", () => {
  it("creates an OPEN recommendation", () => {
    expect(make().status).toBe("OPEN");
  });

  it("rejects invalid input with INVALID_INPUT and issues", () => {
    const r = createRiskRecommendation({
      recommendationId: "",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      assetIds: [],
      source: "NOBODY" as unknown as "INSURER",
      hazardType: "X",
      description: "d",
      approvedActionIds: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.issues?.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("recommendation transitions", () => {
  it("follows OPEN -> ACTION_REPORTED -> VERIFYING -> VERIFIED with a valid assessment", () => {
    let r = make();
    r = step(r, { type: "REPORT_ACTION", at: T });
    expect(r.status).toBe("ACTION_REPORTED");
    expect(isRecommendationVerified(r)).toBe(false);
    r = step(r, { type: "START_VERIFICATION", at: T });
    r = step(r, { type: "RECORD_VERIFICATION", at: T, assessment: sampleAssessment() });
    expect(r.status).toBe("VERIFIED");
    expect(isRecommendationVerified(r)).toBe(true);
  });

  it("maps non-verified outcomes to PARTIAL / UNVERIFIED", () => {
    const base = step(step(make(), { type: "REPORT_ACTION", at: T }), {
      type: "START_VERIFICATION",
      at: T,
    });
    const partial = step(base, {
      type: "RECORD_VERIFICATION",
      at: T,
      assessment: sampleAssessment({ result: "PARTIALLY_VERIFIED" }),
    });
    expect(partial.status).toBe("PARTIAL");
    for (const result of ["NOT_IMPROVING", "INCONCLUSIVE"] as const) {
      const r = step(base, {
        type: "RECORD_VERIFICATION",
        at: T,
        assessment: sampleAssessment({ result }),
      });
      expect(r.status).toBe("UNVERIFIED");
    }
  });

  it("CLOSED is not VERIFIED: closing an unverified recommendation stays unverified", () => {
    const closed = step(make(), { type: "CLOSE", at: T, actorId: "U-1" });
    expect(closed.status).toBe("CLOSED");
    expect(closed.status).not.toBe("VERIFIED");
    expect(isRecommendationVerified(closed)).toBe(false);
  });

  it("closing a reported-but-unverified recommendation does not verify it", () => {
    const reported = step(make(), { type: "REPORT_ACTION", at: T });
    const closed = step(reported, { type: "CLOSE", at: T, actorId: "U-1" });
    expect(isRecommendationVerified(closed)).toBe(false);
  });

  it("cannot reach VERIFIED from OPEN or by reporting an action", () => {
    const r = applyRecommendationCommand(make(), {
      type: "RECORD_VERIFICATION",
      at: T,
      assessment: sampleAssessment(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_RECOMMENDATION_TRANSITION");
    expect(RECOMMENDATION_TRANSITIONS.OPEN).not.toContain("VERIFIED");
    expect(RECOMMENDATION_TRANSITIONS.ACTION_REPORTED).not.toContain("VERIFIED");
  });

  it("rejects VERIFYING outcome without a valid assessment", () => {
    const verifying = step(step(make(), { type: "REPORT_ACTION", at: T }), {
      type: "START_VERIFICATION",
      at: T,
    });
    const r = applyRecommendationCommand(verifying, {
      type: "RECORD_VERIFICATION",
      at: T,
      assessment: sampleAssessment({ requiredCriteria: [] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MISSING_VERIFICATION_REFERENCE");
  });

  it("rejects illegal transitions (VERIFYING -> CLOSED, CLOSED -> ACTION_REPORTED)", () => {
    const verifying = step(step(make(), { type: "REPORT_ACTION", at: T }), {
      type: "START_VERIFICATION",
      at: T,
    });
    const a = applyRecommendationCommand(verifying, { type: "CLOSE", at: T, actorId: "U" });
    expect(a.ok).toBe(false);
    const closed = step(make(), { type: "CLOSE", at: T, actorId: "U" });
    const b = applyRecommendationCommand(closed, { type: "REPORT_ACTION", at: T });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("ILLEGAL_RECOMMENDATION_TRANSITION");
  });

  it("can reopen after closure", () => {
    const closed = step(make(), { type: "CLOSE", at: T, actorId: "U" });
    expect(step(closed, { type: "REOPEN", at: T }).status).toBe("REOPENED");
  });

  it("defines a transition row for every status", () => {
    expect(Object.keys(RECOMMENDATION_TRANSITIONS).sort()).toEqual(
      [...RECOMMENDATION_STATUSES].sort(),
    );
  });

  it("is deterministic and does not mutate its input", () => {
    const r = make();
    const cmd: RecommendationCommand = { type: "REPORT_ACTION", at: T };
    const a = applyRecommendationCommand(r, cmd);
    const b = applyRecommendationCommand(r, cmd);
    expect(a).toEqual(b);
    expect(r.status).toBe("OPEN");
  });
});
