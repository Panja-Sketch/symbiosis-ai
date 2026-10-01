import { describe, expect, it } from "vitest";
import type { RiskEvent, RiskEventState, RiskImprovementCase } from "@symbiosis/contracts";
import { RISK_EVENT_STATES } from "@symbiosis/contracts";
import { applyCaseCommand, createRiskImprovementCase } from "@symbiosis/risk-cases";
import { sampleAssessment } from "@symbiosis/verification/testing";
import {
  RISK_EVENT_TRANSITIONS,
  applyRiskEventCommand,
  completeVerification,
  createRiskEvent,
  grantsMitigationCredit,
  reopenOnRecurrence,
} from "./index";
import type { RiskEventCommand } from "./index";

const T0 = "2026-01-01T00:00:00Z";
const T = (n: number) => `2026-01-02T00:${String(n).padStart(2, "0")}:00Z`;

function newEvent(eventId = "EVT-1"): RiskEvent {
  const r = createRiskEvent({
    eventId,
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    detectedAt: T0,
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function step(e: RiskEvent, c: RiskEventCommand): RiskEvent {
  const r = applyRiskEventCommand(e, c);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}: ${r.error.message}`);
  return r.value.value;
}

const alerted = (e: RiskEvent) => step(e, { type: "ALERT", at: T(1) });
const acked = (e: RiskEvent) => step(alerted(e), { type: "ACKNOWLEDGE", at: T(2), actorId: "U-1" });
const actionReported = (e: RiskEvent) =>
  step(acked(e), { type: "REPORT_ACTION", at: T(3), actorId: "U-1", actionId: "ACT-1" });
const verifying = (e: RiskEvent) =>
  step(actionReported(e), { type: "START_VERIFICATION", at: T(4) });

describe("createRiskEvent", () => {
  it("creates a DETECTED event", () => {
    expect(newEvent()).toMatchObject({ state: "DETECTED", updatedAt: T0 });
  });

  it("rejects invalid input", () => {
    const r = createRiskEvent({
      eventId: "",
      caseId: "C",
      organizationId: "O",
      facilityId: "F",
      assetIds: [],
      detectedAt: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
});

describe("risk event lifecycle", () => {
  it("walks the happy path DETECTED -> ... -> VERIFIED with an assessment", () => {
    const states: RiskEventState[] = [];
    let e = newEvent();
    const commands: RiskEventCommand[] = [
      { type: "ALERT", at: T(1) },
      { type: "ACKNOWLEDGE", at: T(2), actorId: "U-1" },
      { type: "REPORT_ACTION", at: T(3), actorId: "U-1", actionId: "ACT-1" },
      { type: "START_VERIFICATION", at: T(4) },
      { type: "COMPLETE_VERIFICATION", at: T(5), assessment: sampleAssessment() },
    ];
    for (const c of commands) {
      e = step(e, c);
      states.push(e.state);
    }
    expect(states).toEqual(["ALERTED", "ACKNOWLEDGED", "ACTION_REPORTED", "VERIFYING", "VERIFIED"]);
    expect(e.latestVerificationId).toBe("VER-1");
  });

  it("escalation path: ALERTED -> ESCALATED -> ACKNOWLEDGED", () => {
    const escalated = step(alerted(newEvent()), { type: "ESCALATE", at: T(2) });
    expect(escalated.state).toBe("ESCALATED");
    expect(step(escalated, { type: "ACKNOWLEDGE", at: T(3), actorId: "U-1" }).state).toBe(
      "ACKNOWLEDGED",
    );
  });

  it("acknowledgement alone never reaches a verified state", () => {
    const e = acked(newEvent());
    expect(e.state).toBe("ACKNOWLEDGED");
    expect(e.latestVerificationId).toBeUndefined();
    expect(grantsMitigationCredit(e.state)).toBe(false);
  });

  it("reported action does not verify: it only reaches ACTION_REPORTED", () => {
    const e = actionReported(newEvent());
    expect(e.state).toBe("ACTION_REPORTED");
    expect(grantsMitigationCredit(e.state)).toBe(false);
  });

  it("self-resolved path ends terminal with no mitigation credit", () => {
    const e = step(alerted(newEvent()), { type: "MARK_SELF_RESOLVED", at: T(2) });
    expect(e.state).toBe("SELF_RESOLVED");
    expect(grantsMitigationCredit(e.state)).toBe(false);
    expect(RISK_EVENT_TRANSITIONS.SELF_RESOLVED).toEqual([]);
    const retry = applyRiskEventCommand(e, {
      type: "COMPLETE_VERIFICATION",
      at: T(3),
      assessment: sampleAssessment(),
    });
    expect(retry.ok).toBe(false);
  });

  it("false-alarm dismissal requires actor and reason and is terminal", () => {
    const e = alerted(newEvent());
    const noReason = applyRiskEventCommand(e, {
      type: "DISMISS_FALSE_ALARM",
      at: T(2),
      actorId: "U-1",
      reason: "",
    });
    expect(noReason.ok).toBe(false);
    const d = step(e, {
      type: "DISMISS_FALSE_ALARM",
      at: T(2),
      actorId: "U-1",
      reason: "Sensor calibration",
    });
    expect(d.state).toBe("DISMISSED_FALSE_ALARM");
    expect(RISK_EVENT_TRANSITIONS.DISMISSED_FALSE_ALARM).toEqual([]);
    expect(grantsMitigationCredit(d.state)).toBe(false);
  });

  it("only VERIFIED earns mitigation credit", () => {
    for (const s of RISK_EVENT_STATES) {
      expect(grantsMitigationCredit(s)).toBe(s === "VERIFIED");
    }
  });

  it.each([
    ["DETECTED", { type: "ACKNOWLEDGE", at: T(1), actorId: "U" }],
    ["DETECTED", { type: "REPORT_ACTION", at: T(1), actorId: "U", actionId: "A" }],
    ["ALERTED", { type: "REPORT_ACTION", at: T(2), actorId: "U", actionId: "A" }],
    ["ALERTED", { type: "START_VERIFICATION", at: T(2) }],
    ["ACKNOWLEDGED", { type: "START_VERIFICATION", at: T(3) }],
    ["ACKNOWLEDGED", { type: "COMPLETE_VERIFICATION", at: T(3), assessment: sampleAssessment() }],
    [
      "ACTION_REPORTED",
      { type: "COMPLETE_VERIFICATION", at: T(4), assessment: sampleAssessment() },
    ],
  ] as const)("rejects illegal transition: %s + %j", (from, command) => {
    const prep: Record<string, () => RiskEvent> = {
      DETECTED: newEvent,
      ALERTED: () => alerted(newEvent()),
      ACKNOWLEDGED: () => acked(newEvent()),
      ACTION_REPORTED: () => actionReported(newEvent()),
    };
    const r = applyRiskEventCommand(prep[from]!(), command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });

  it("rejects an invalid or mismatched assessment even from VERIFYING", () => {
    const v = verifying(newEvent());
    const bad = applyRiskEventCommand(v, {
      type: "COMPLETE_VERIFICATION",
      at: T(5),
      assessment: sampleAssessment({ evidenceIds: [] }),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("MISSING_VERIFICATION_REFERENCE");
    const other = applyRiskEventCommand(v, {
      type: "COMPLETE_VERIFICATION",
      at: T(5),
      assessment: sampleAssessment({ eventId: "EVT-OTHER" }),
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("VERIFICATION_MISMATCH");
  });

  it.each(["PARTIALLY_VERIFIED", "NOT_IMPROVING", "INCONCLUSIVE"] as const)(
    "VERIFYING -> %s, then another action cycle is allowed",
    (result) => {
      const e = step(verifying(newEvent()), {
        type: "COMPLETE_VERIFICATION",
        at: T(5),
        assessment: sampleAssessment({ result }),
      });
      expect(e.state).toBe(result);
      expect(grantsMitigationCredit(e.state)).toBe(false);
      const again = step(e, { type: "REPORT_ACTION", at: T(6), actorId: "U", actionId: "ACT-2" });
      expect(again.state).toBe("ACTION_REPORTED");
    },
  );

  it("VERIFIED is terminal", () => {
    expect(RISK_EVENT_TRANSITIONS.VERIFIED).toEqual([]);
  });

  it("has a transition row for every state; VERIFIED is only reachable from VERIFYING", () => {
    expect(Object.keys(RISK_EVENT_TRANSITIONS).sort()).toEqual([...RISK_EVENT_STATES].sort());
    const sources = RISK_EVENT_STATES.filter((s) => RISK_EVENT_TRANSITIONS[s].includes("VERIFIED"));
    expect(sources).toEqual(["VERIFYING"]);
  });

  it("rejects time going backwards", () => {
    const r = applyRiskEventCommand(alerted(newEvent()), { type: "ESCALATE", at: T0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TIMESTAMP_REGRESSION");
  });

  it("is deterministic and never mutates its input", () => {
    const e = alerted(newEvent());
    const cmd: RiskEventCommand = { type: "ACKNOWLEDGE", at: T(2), actorId: "U-1" };
    expect(applyRiskEventCommand(e, cmd)).toEqual(applyRiskEventCommand(e, cmd));
    expect(e.state).toBe("ALERTED");
  });
});

// ---- Case + event coordination ----

function caseAtVerifying(): { c: RiskImprovementCase; e: RiskEvent } {
  const created = createRiskImprovementCase({
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
    hazardType: "COOLING_FAN_DEGRADATION",
    title: "Fan degradation",
    severity: "HIGH",
    createdAt: T0,
  });
  if (!created.ok) throw new Error("fixture");
  let c = created.value;
  const run = (cmd: Parameters<typeof applyCaseCommand>[1]) => {
    const r = applyCaseCommand(c, cmd);
    if (!r.ok) throw new Error(r.error.code);
    c = r.value.value;
  };
  run({ type: "REQUIRE_ACTION", at: T(1), riskEventId: "EVT-1" });
  run({ type: "REPORT_ACTION", at: T(3), actionId: "ACT-1" });
  run({ type: "START_VERIFICATION", at: T(4) });
  return { c, e: verifying(newEvent()) };
}

describe("completeVerification (case + event)", () => {
  it("moves both aggregates to their verified states together", () => {
    const { c, e } = caseAtVerifying();
    const r = completeVerification({ case: c, event: e, assessment: sampleAssessment(), at: T(5) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.case.state).toBe("VERIFIED_IMPROVED");
      expect(r.value.event.state).toBe("VERIFIED");
      expect(r.value.case.latestVerificationId).toBe("VER-1");
      expect(r.value.caseRecord.to).toBe("VERIFIED_IMPROVED");
      expect(r.value.eventRecord.to).toBe("VERIFIED");
    }
  });

  it("an unverified outcome moves neither aggregate to a verified state", () => {
    const { c, e } = caseAtVerifying();
    const r = completeVerification({
      case: c,
      event: e,
      assessment: sampleAssessment({ result: "INCONCLUSIVE", evidenceIds: [] }),
      at: T(5),
    });
    expect(r.ok && [r.value.case.state, r.value.event.state]).toEqual([
      "INCONCLUSIVE",
      "INCONCLUSIVE",
    ]);
  });

  it("rejects an event that is not the case's active event", () => {
    const { c } = caseAtVerifying();
    const r = completeVerification({
      case: c,
      event: verifying(newEvent("EVT-2")),
      assessment: sampleAssessment(),
      at: T(5),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VERIFICATION_MISMATCH");
  });

  it("rejects when the event is not VERIFYING", () => {
    const { c } = caseAtVerifying();
    const r = completeVerification({
      case: c,
      event: acked(newEvent()),
      assessment: sampleAssessment(),
      at: T(5),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });
});

describe("reopenOnRecurrence", () => {
  function verifiedCase(): RiskImprovementCase {
    const { c, e } = caseAtVerifying();
    const r = completeVerification({ case: c, event: e, assessment: sampleAssessment(), at: T(5) });
    if (!r.ok) throw new Error("fixture");
    return r.value.case;
  }

  it("reopens a verified case with a new event and increments recurrence", () => {
    const r = reopenOnRecurrence({ case: verifiedCase(), newEvent: newEvent("EVT-2"), at: T(10) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.case).toMatchObject({
        state: "REOPENED",
        recurrenceCount: 1,
        activeRiskEventId: "EVT-2",
      });
      expect(r.value.caseRecord).toMatchObject({ from: "VERIFIED_IMPROVED", to: "REOPENED" });
    }
  });

  it("rejects an event from another case or one that is not freshly DETECTED", () => {
    const c = verifiedCase();
    const wrongCase = { ...newEvent("EVT-2"), caseId: "CASE-OTHER" };
    expect(reopenOnRecurrence({ case: c, newEvent: wrongCase, at: T(10) }).ok).toBe(false);
    const notNew = alerted(newEvent("EVT-3"));
    const r = reopenOnRecurrence({ case: c, newEvent: notNew, at: T(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
  });

  it("rejects recurrence on a case that has not been verified or closed", () => {
    const { c } = caseAtVerifying();
    const r = reopenOnRecurrence({ case: c, newEvent: newEvent("EVT-2"), at: T(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECURRENCE");
  });
});
