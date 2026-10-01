import { describe, expect, it } from "vitest";
import type { RiskDetection, RiskImprovementCase, VerificationAttempt } from "@symbiosis/contracts";
import { sampleAssessment } from "@symbiosis/verification/testing";
import { decideRecurrence, isQualifiedDetection, reopenCaseForRecurrence } from "./index";

const WATCH_END = "2026-10-01T03:00:00.000Z";

const verifiedCase: RiskImprovementCase = {
  caseId: "CASE-1",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetIds: ["AST-FAN", "AST-OUT"],
  origin: { type: "DETECTED_HAZARD", detectionId: "DET-0" },
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  title: "t",
  severity: "MODERATE",
  activeRiskEventId: "RE-1",
  latestVerificationId: "VER-1",
  state: "VERIFIED_IMPROVED",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T02:00:00.000Z",
};

const attempt = (over: Partial<VerificationAttempt> = {}): VerificationAttempt => ({
  verificationId: "VER-1",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  caseId: "CASE-1",
  eventId: "RE-1",
  policyId: "POL",
  policyVersion: "1",
  actionIds: ["ACT-1"],
  actionLibraryIds: ["ACT-COOLING-INSPECT-PRIMARY"],
  postActionWindow: { start: "2026-10-01T01:00:00.000Z", end: "2026-10-01T02:00:00.000Z" },
  requiredAssetIds: ["AST-FAN"],
  requiredSignals: [],
  startedAt: "2026-10-01T01:00:00.000Z",
  correlationId: "CORR-1",
  status: "COMPLETED",
  evaluatedAt: "2026-10-01T02:00:00.000Z",
  assessment: sampleAssessment({ caseId: "CASE-1", eventId: "RE-1", result: "VERIFIED" }),
  recurrenceWatchEndsAt: WATCH_END,
  ...over,
});

const detection = (over: Partial<RiskDetection> = {}): RiskDetection => ({
  detectionId: "DET-9",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-FAN",
  contextAssetIds: ["AST-OUT"],
  severity: "HIGH",
  confidence: 1,
  detectedAt: "2026-10-01T02:30:00.000Z",
  reasonCodes: ["VIBRATION_Z_AT_OR_ABOVE_THRESHOLD"],
  supportingObservationIds: [],
  baselineIds: [],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: {},
  ...over,
});

const candidates = (...args: [] | [VerificationAttempt | undefined]) => [
  { caseRecord: verifiedCase, verification: args.length === 0 ? attempt() : args[0] },
];

describe("decideRecurrence", () => {
  it("reopens the verified case for a qualifying detection inside the watch window", () => {
    const d = decideRecurrence({ detection: detection(), candidates: candidates() });
    expect(d).toMatchObject({ kind: "REOPEN", watchEndsAt: WATCH_END });
  });

  it("counts a detection exactly at the end of the window", () => {
    expect(
      decideRecurrence({
        detection: detection({ detectedAt: WATCH_END }),
        candidates: candidates(),
      }).kind,
    ).toBe("REOPEN");
  });

  it("outside the window it is a new episode, not a recurrence", () => {
    expect(
      decideRecurrence({
        detection: detection({ detectedAt: "2026-10-01T03:00:00.001Z" }),
        candidates: candidates(),
      }),
    ).toEqual({ kind: "NONE", reason: "OUTSIDE_RECURRENCE_WINDOW" });
  });

  it("a detection that did not persist (a WATCH-like signal) never reopens", () => {
    const weak = detection({ persistence: { qualifyingEvaluations: 1, required: 3 } });
    expect(isQualifiedDetection(weak)).toBe(false);
    expect(decideRecurrence({ detection: weak, candidates: candidates() })).toEqual({
      kind: "NONE",
      reason: "DETECTION_NOT_QUALIFIED",
    });
  });

  it("does not merge a different hazard, asset, facility or organization", () => {
    for (const other of [
      { hazardType: "OTHER_HAZARD" },
      { primaryAssetId: "AST-OTHER" },
      { facilityId: "FAC-2" },
      { organizationId: "ORG-2" },
    ]) {
      expect(decideRecurrence({ detection: detection(other), candidates: candidates() })).toEqual({
        kind: "NONE",
        reason: "NO_VERIFIED_CASE_FOR_EPISODE",
      });
    }
  });

  it("requires a completed VERIFIED verification record that the case points at", () => {
    const bad: (VerificationAttempt | undefined)[] = [
      undefined,
      attempt({ status: "IN_PROGRESS" }),
      attempt({ verificationId: "VER-OTHER" }),
      attempt({ assessment: sampleAssessment({ result: "NOT_IMPROVING" }) }),
      (() => {
        const { recurrenceWatchEndsAt: _w, ...rest } = attempt();
        void _w;
        return rest;
      })(),
    ];
    for (const a of bad) {
      expect(decideRecurrence({ detection: detection(), candidates: candidates(a) }).kind).toBe(
        "NONE",
      );
    }
  });

  it("ignores cases that are not VERIFIED_IMPROVED", () => {
    for (const state of ["CLOSED", "OPEN", "REOPENED", "NOT_IMPROVING"] as const) {
      const d = decideRecurrence({
        detection: detection(),
        candidates: [{ caseRecord: { ...verifiedCase, state }, verification: attempt() }],
      });
      expect(d.kind, state).toBe("NONE");
    }
  });
});

describe("reopenCaseForRecurrence", () => {
  it("keeps the case id, adds one recurrence and a new DETECTED event, raising severity", () => {
    const r = reopenCaseForRecurrence({
      caseRecord: verifiedCase,
      detection: detection({ severity: "CRITICAL" }),
      newEventId: "RE-2",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.case).toMatchObject({
        caseId: "CASE-1",
        state: "REOPENED",
        recurrenceCount: 1,
        activeRiskEventId: "RE-2",
        latestVerificationId: "VER-1",
        severity: "CRITICAL",
      });
      expect(r.value.newEvent).toMatchObject({
        eventId: "RE-2",
        caseId: "CASE-1",
        state: "DETECTED",
        assetIds: ["AST-FAN", "AST-OUT"],
      });
      expect(r.value.previousRiskEventId).toBe("RE-1");
      expect(r.value.caseRecord).toMatchObject({ from: "VERIFIED_IMPROVED", to: "REOPENED" });
    }
  });

  it("counts every recurrence", () => {
    const first = reopenCaseForRecurrence({
      caseRecord: verifiedCase,
      detection: detection(),
      newEventId: "RE-2",
    });
    if (!first.ok) throw new Error("first");
    expect(first.value.case.recurrenceCount).toBe(1);
    const again = reopenCaseForRecurrence({
      caseRecord: {
        ...first.value.case,
        state: "VERIFIED_IMPROVED",
        updatedAt: "2026-10-01T02:30:00.000Z",
      },
      detection: detection({ detectedAt: "2026-10-01T02:40:00.000Z" }),
      newEventId: "RE-3",
    });
    expect(again.ok && again.value.case.recurrenceCount).toBe(2);
  });

  it("fails closed for a case that is not VERIFIED_IMPROVED", () => {
    const r = reopenCaseForRecurrence({
      caseRecord: { ...verifiedCase, state: "CLOSED" },
      detection: detection(),
      newEventId: "RE-2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
  });
});
