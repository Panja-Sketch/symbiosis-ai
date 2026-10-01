import { describe, expect, it } from "vitest";
import type { CaseState, RiskImprovementCase } from "@symbiosis/contracts";
import { CASE_STATES } from "@symbiosis/contracts";
import { sampleAssessment } from "@symbiosis/verification/testing";
import {
  CASE_TRANSITIONS,
  applyCaseCommand,
  checkCaseInvariants,
  createRiskImprovementCase,
} from "./index";
import type { CaseCommand } from "./index";

const T0 = "2026-01-01T00:00:00Z";
const T = (n: number) => `2026-01-02T00:${String(n).padStart(2, "0")}:00Z`;

function newCase(): RiskImprovementCase {
  const r = createRiskImprovementCase({
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    origin: { type: "RECOMMENDATION", recommendationId: "REC-1" },
    hazardType: "COOLING_FAN_DEGRADATION",
    title: "Primary fan degradation",
    severity: "HIGH",
    createdAt: T0,
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function step(c: RiskImprovementCase, command: CaseCommand): RiskImprovementCase {
  const r = applyCaseCommand(c, command);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.message}`);
  return r.value.value;
}

const requireAction = (c: RiskImprovementCase, n = 1) =>
  step(c, { type: "REQUIRE_ACTION", at: T(n), riskEventId: "EVT-1", ownerId: "U-1" });
const reported = (c: RiskImprovementCase, n = 2) =>
  step(c, { type: "REPORT_ACTION", at: T(n), actionId: "ACT-1" });
const verifying = (c: RiskImprovementCase, n = 3) =>
  step(c, { type: "START_VERIFICATION", at: T(n) });
const record = (c: RiskImprovementCase, result: Parameters<typeof sampleAssessment>[0], n = 4) =>
  step(c, { type: "RECORD_VERIFICATION", at: T(n), assessment: sampleAssessment(result) });

const toVerifying = () => verifying(reported(requireAction(newCase())));
const toVerified = () => record(toVerifying(), {});

describe("createRiskImprovementCase", () => {
  it("creates a valid OPEN case with defaults", () => {
    const c = newCase();
    expect(c).toMatchObject({
      state: "OPEN",
      recurrenceCount: 0,
      sharingState: "NOT_SHARED",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(c.latestVerificationId).toBeUndefined();
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("preserves optional references supplied at creation", () => {
    const r = createRiskImprovementCase({
      caseId: "CASE-2",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      assetIds: ["AST-1", "AST-2"],
      origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
      hazardType: "H",
      title: "T",
      severity: "LOW",
      baselineSnapshotId: "BSL-1",
      activeRiskEventId: "EVT-9",
      assignedOwnerId: "U-2",
      targetDate: "2026-02-01T00:00:00Z",
      createdAt: T0,
    });
    expect(r.ok && r.value).toMatchObject({
      baselineSnapshotId: "BSL-1",
      activeRiskEventId: "EVT-9",
      assignedOwnerId: "U-2",
      assetIds: ["AST-1", "AST-2"],
    });
  });

  it("rejects invalid initial data with INVALID_INPUT", () => {
    const base = {
      caseId: "C",
      organizationId: "O",
      facilityId: "F",
      assetIds: ["A"],
      origin: { type: "MANUAL_RISK_REVIEW", reviewId: "R" },
      hazardType: "H",
      title: "T",
      severity: "LOW",
      createdAt: T0,
    } as const;
    const bad = [
      { ...base, caseId: "" },
      { ...base, assetIds: [] },
      { ...base, severity: "SEVERE" as unknown as "LOW" },
      { ...base, origin: { type: "RECOMMENDATION", recommendationId: "" } as const },
      { ...base, createdAt: "not-a-date" },
      { ...base, targetDate: "soon" },
    ];
    for (const input of bad) {
      const r = createRiskImprovementCase(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("case lifecycle", () => {
  it("OPEN -> ACTION_REQUIRED sets event, owner; records transition", () => {
    const r = applyCaseCommand(newCase(), {
      type: "REQUIRE_ACTION",
      at: T(1),
      riskEventId: "EVT-1",
      ownerId: "U-1",
      targetDate: "2026-03-01T00:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toMatchObject({
        state: "ACTION_REQUIRED",
        activeRiskEventId: "EVT-1",
        assignedOwnerId: "U-1",
        targetDate: "2026-03-01T00:00:00Z",
        updatedAt: T(1),
      });
      expect(r.value.record).toMatchObject({
        entity: "CASE",
        from: "OPEN",
        to: "ACTION_REQUIRED",
        command: "REQUIRE_ACTION",
        at: T(1),
      });
    }
  });

  it("reporting an action moves to ACTION_REPORTED and never to a verified state", () => {
    const c = reported(requireAction(newCase()));
    expect(c.state).toBe("ACTION_REPORTED");
    expect(c.latestVerificationId).toBeUndefined();
    expect(c.state).not.toBe("VERIFIED_IMPROVED");
  });

  it("rejects reporting an action with no active risk event", () => {
    const c = step(newCase(), { type: "REQUIRE_ACTION", at: T(1) });
    const r = applyCaseCommand(c, { type: "REPORT_ACTION", at: T(2), actionId: "ACT-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MISSING_ACTIVE_RISK_EVENT");
  });

  it("VERIFYING -> VERIFIED_IMPROVED with a valid VERIFIED assessment", () => {
    const c = toVerified();
    expect(c.state).toBe("VERIFIED_IMPROVED");
    expect(c.latestVerificationId).toBe("VER-1");
  });

  it.each([
    ["PARTIALLY_VERIFIED", "PARTIALLY_VERIFIED"],
    ["NOT_IMPROVING", "NOT_IMPROVING"],
    ["INCONCLUSIVE", "INCONCLUSIVE"],
  ] as const)("VERIFYING -> %s outcome maps to case state %s", (result, state) => {
    const c = record(toVerifying(), { result });
    expect(c.state).toBe(state);
    expect(c.latestVerificationId).toBe("VER-1");
  });

  it("rejects direct OPEN -> VERIFIED_IMPROVED even with a valid assessment", () => {
    const r = applyCaseCommand(newCase(), {
      type: "RECORD_VERIFICATION",
      at: T(1),
      assessment: sampleAssessment(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
      expect(r.error).toMatchObject({ from: "OPEN", to: "VERIFIED_IMPROVED" });
    }
  });

  it("rejects ACTION_REPORTED -> VERIFIED_IMPROVED (skipping VERIFYING)", () => {
    const r = applyCaseCommand(reported(requireAction(newCase())), {
      type: "RECORD_VERIFICATION",
      at: T(3),
      assessment: sampleAssessment(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });

  it("requires a valid verification reference to reach a verified state", () => {
    const v = toVerifying();
    const noCriteria = applyCaseCommand(v, {
      type: "RECORD_VERIFICATION",
      at: T(4),
      assessment: sampleAssessment({ requiredCriteria: [] }),
    });
    expect(noCriteria.ok).toBe(false);
    if (!noCriteria.ok) expect(noCriteria.error.code).toBe("MISSING_VERIFICATION_REFERENCE");

    const missing = applyCaseCommand(v, {
      type: "RECORD_VERIFICATION",
      at: T(4),
      assessment: undefined as never,
    });
    expect(missing.ok).toBe(false);
  });

  it("rejects an assessment that belongs to another case or event", () => {
    for (const overrides of [{ caseId: "CASE-OTHER" }, { eventId: "EVT-OTHER" }]) {
      const r = applyCaseCommand(toVerifying(), {
        type: "RECORD_VERIFICATION",
        at: T(4),
        assessment: sampleAssessment(overrides),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("VERIFICATION_MISMATCH");
    }
  });

  it("not-improving cases require a new action cycle", () => {
    const c = record(toVerifying(), { result: "NOT_IMPROVING" });
    expect(step(c, { type: "REQUIRE_ACTION", at: T(5) }).state).toBe("ACTION_REQUIRED");
  });

  it("inconclusive cases may re-enter VERIFYING for more data", () => {
    const c = record(toVerifying(), { result: "INCONCLUSIVE" });
    expect(verifying(c, 5).state).toBe("VERIFYING");
  });

  it("administrative closure of an unverified case does not imply verification", () => {
    const c = step(reported(requireAction(newCase())), {
      type: "CLOSE",
      at: T(3),
      actorId: "U-1",
      reason: "Site decommissioned",
    });
    expect(c.state).toBe("CLOSED");
    expect(c.latestVerificationId).toBeUndefined();
    expect(c.state).not.toBe("VERIFIED_IMPROVED");
  });

  it("closing requires an actor and reason, and is impossible while VERIFYING", () => {
    const noReason = applyCaseCommand(newCase(), {
      type: "CLOSE",
      at: T(1),
      actorId: "U-1",
      reason: " ",
    });
    expect(noReason.ok).toBe(false);
    const whileVerifying = applyCaseCommand(toVerifying(), {
      type: "CLOSE",
      at: T(5),
      actorId: "U-1",
      reason: "x",
    });
    expect(whileVerifying.ok).toBe(false);
    if (!whileVerifying.ok) expect(whileVerifying.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });

  it("closing a verified case keeps its verification reference", () => {
    const c = step(toVerified(), { type: "CLOSE", at: T(5), actorId: "U-1", reason: "done" });
    expect(c.state).toBe("CLOSED");
    expect(c.latestVerificationId).toBe("VER-1");
  });

  it("rejects timestamps earlier than the last update", () => {
    const r = applyCaseCommand(requireAction(newCase(), 10), {
      type: "REPORT_ACTION",
      at: T(5),
      actionId: "ACT-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMESTAMP_REGRESSION");
  });
});

describe("recurrence", () => {
  const recur = (c: RiskImprovementCase, id = "EVT-2", n = 6): CaseCommand => ({
    type: "RECORD_RECURRENCE",
    at: T(n),
    newRiskEventId: id,
  });

  it("a verified case reopens, increments recurrenceCount and tracks the new event", () => {
    const c = step(toVerified(), recur(toVerified()));
    expect(c).toMatchObject({
      state: "REOPENED",
      recurrenceCount: 1,
      activeRiskEventId: "EVT-2",
    });
    expect(c.latestVerificationId).toBe("VER-1");
  });

  it("recurrence count accumulates across cycles", () => {
    let c = step(toVerified(), recur(toVerified(), "EVT-2", 6));
    c = step(c, { type: "REQUIRE_ACTION", at: T(7) });
    c = step(c, { type: "REPORT_ACTION", at: T(8), actionId: "ACT-2" });
    c = step(c, { type: "START_VERIFICATION", at: T(9) });
    c = step(c, {
      type: "RECORD_VERIFICATION",
      at: T(10),
      assessment: sampleAssessment({ verificationId: "VER-2", eventId: "EVT-2" }),
    });
    c = step(c, recur(c, "EVT-3", 11));
    expect(c.recurrenceCount).toBe(2);
    expect(c.activeRiskEventId).toBe("EVT-3");
  });

  it("an administratively closed case is not eligible for recurrence (CLOSED != VERIFIED)", () => {
    const closed = step(newCase(), { type: "CLOSE", at: T(1), actorId: "U", reason: "r" });
    const r = applyCaseCommand(closed, recur(closed, "EVT-2", 2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
  });

  it("a closed-after-verified case is also not reopened by recurrence", () => {
    const closed = step(toVerified(), { type: "CLOSE", at: T(5), actorId: "U", reason: "r" });
    const r = applyCaseCommand(closed, recur(closed, "EVT-2", 6));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
  });

  it.each(["OPEN", "ACTION_REQUIRED", "ACTION_REPORTED", "VERIFYING", "NOT_IMPROVING"] as const)(
    "rejects recurrence from %s with INVALID_RECURRENCE",
    (state) => {
      const builders: Record<string, () => RiskImprovementCase> = {
        OPEN: newCase,
        ACTION_REQUIRED: () => requireAction(newCase()),
        ACTION_REPORTED: () => reported(requireAction(newCase())),
        VERIFYING: toVerifying,
        NOT_IMPROVING: () => record(toVerifying(), { result: "NOT_IMPROVING" }),
      };
      const c = builders[state]!();
      const r = applyCaseCommand(c, recur(c, "EVT-2", 7));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
    },
  );

  it("rejects recurrence that reuses the active event or has no new event", () => {
    const v = toVerified();
    for (const id of ["EVT-1", ""]) {
      const r = applyCaseCommand(v, recur(v, id));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
    }
  });
});

describe("transition table and invariants", () => {
  it("has a row for every case state", () => {
    expect(Object.keys(CASE_TRANSITIONS).sort()).toEqual([...CASE_STATES].sort());
  });

  it("VERIFIED_IMPROVED is reachable only from VERIFYING", () => {
    const sources = CASE_STATES.filter((s) => CASE_TRANSITIONS[s].includes("VERIFIED_IMPROVED"));
    expect(sources).toEqual(["VERIFYING"]);
  });

  it("no state other than VERIFYING can transition into any verification outcome state", () => {
    const outcomes: CaseState[] = [
      "VERIFIED_IMPROVED",
      "PARTIALLY_VERIFIED",
      "NOT_IMPROVING",
      "INCONCLUSIVE",
    ];
    for (const s of CASE_STATES) {
      if (s === "VERIFYING") continue;
      for (const o of outcomes) {
        if (s === "INCONCLUSIVE" && o === "INCONCLUSIVE") continue;
        expect(CASE_TRANSITIONS[s]).not.toContain(o);
      }
    }
  });

  it("CLOSED is terminal: it is never a source of verified or reopened states", () => {
    expect(CASE_TRANSITIONS.CLOSED).toEqual([]);
    expect(CASE_STATES.filter((s) => CASE_TRANSITIONS[s].includes("REOPENED"))).toEqual([
      "VERIFIED_IMPROVED",
    ]);
  });

  it("flags verification-backed states that lack a verification reference", () => {
    const forged = { ...newCase(), state: "VERIFIED_IMPROVED" as const };
    expect(checkCaseInvariants(forged)).toContain(
      "VERIFIED_IMPROVED requires latestVerificationId",
    );
    const reopened = { ...newCase(), state: "REOPENED" as const };
    expect(checkCaseInvariants(reopened).length).toBeGreaterThan(0);
  });

  it("is deterministic and never mutates its input", () => {
    const c = requireAction(newCase());
    const cmd: CaseCommand = { type: "REPORT_ACTION", at: T(2), actionId: "ACT-1" };
    const a = applyCaseCommand(c, cmd);
    const b = applyCaseCommand(c, cmd);
    expect(a).toEqual(b);
    expect(c.state).toBe("ACTION_REQUIRED");
  });
});
