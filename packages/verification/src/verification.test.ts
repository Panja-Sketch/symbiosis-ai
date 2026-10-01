import { describe, expect, it } from "vitest";
import { validateVerificationAssessment } from "./index";
import { sampleAssessment } from "./fixtures";

describe("validateVerificationAssessment", () => {
  it("accepts a self-consistent VERIFIED assessment", () => {
    expect(validateVerificationAssessment(sampleAssessment()).ok).toBe(true);
  });

  it("rejects VERIFIED when a required criterion failed", () => {
    const r = validateVerificationAssessment(
      sampleAssessment({ requiredCriteria: [{ criterionId: "C-1", passed: false }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects VERIFIED with no required criteria", () => {
    expect(validateVerificationAssessment(sampleAssessment({ requiredCriteria: [] })).ok).toBe(
      false,
    );
  });

  it("rejects VERIFIED with no evidence IDs", () => {
    expect(validateVerificationAssessment(sampleAssessment({ evidenceIds: [] })).ok).toBe(false);
  });

  it("allows INCONCLUSIVE without evidence or passing criteria", () => {
    const r = validateVerificationAssessment(
      sampleAssessment({
        result: "INCONCLUSIVE",
        evidenceIds: [],
        requiredCriteria: [{ criterionId: "C-1", passed: false }],
        dataCompleteness: 0.1,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects out-of-range numbers, bad windows and unknown results", () => {
    expect(validateVerificationAssessment(sampleAssessment({ confidence: 1.5 })).ok).toBe(false);
    expect(validateVerificationAssessment(sampleAssessment({ dataCompleteness: -0.1 })).ok).toBe(
      false,
    );
    expect(
      validateVerificationAssessment(
        sampleAssessment({
          postActionWindow: { start: "2026-01-01T04:00:00Z", end: "2026-01-01T03:00:00Z" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateVerificationAssessment(sampleAssessment({ result: "MAYBE" as unknown as "VERIFIED" }))
        .ok,
    ).toBe(false);
  });
});
