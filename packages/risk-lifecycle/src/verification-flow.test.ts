import { describe, expect, it } from "vitest";
import type { RiskEvent, RiskImprovementCase } from "@symbiosis/contracts";
import { CASE_STATES, RISK_EVENT_STATES } from "@symbiosis/contracts";
import { sampleAssessment } from "@symbiosis/verification/testing";
import { CASE_TRANSITIONS, applyCaseCommand } from "@symbiosis/risk-cases";
import {
  RISK_EVENT_TRANSITIONS,
  applyRiskEventCommand,
  completeVerification,
  createRiskEvent,
  reopenOnRecurrence,
  startVerification,
} from "./index";

const T = (n: number) => `2026-01-02T00:${String(n).padStart(2, "0")}:00Z`;

function reported(): { c: RiskImprovementCase; e: RiskEvent } {
  const ev = createRiskEvent({
    eventId: "EVT-1",
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    detectedAt: "2026-01-01T00:00:00Z",
  });
  if (!ev.ok) throw new Error("event");
  let e = ev.value;
  for (const cmd of [
    { type: "ALERT", at: T(1) },
    { type: "ACKNOWLEDGE", at: T(2), actorId: "U" },
    { type: "REPORT_ACTION", at: T(3), actorId: "U", actionId: "ACT-1" },
  ] as const) {
    const r = applyRiskEventCommand(e, cmd);
    if (!r.ok) throw new Error(r.error.code);
    e = r.value.value;
  }
  let c: RiskImprovementCase = {
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["AST-1"],
    origin: { type: "DETECTED_HAZARD", detectionId: "D" },
    hazardType: "H",
    title: "t",
    severity: "HIGH",
    activeRiskEventId: "EVT-1",
    state: "OPEN",
    recurrenceCount: 0,
    sharingState: "NOT_SHARED",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  for (const cmd of [
    { type: "REQUIRE_ACTION", at: T(2) },
    { type: "REPORT_ACTION", at: T(3), actionId: "ACT-1" },
  ] as const) {
    const r = applyCaseCommand(c, cmd);
    if (!r.ok) throw new Error(r.error.code);
    c = r.value.value;
  }
  return { c, e };
}

describe("an action report can never produce a verified state", () => {
  it("only VERIFYING can reach VERIFIED / VERIFIED_IMPROVED (tables)", () => {
    expect(RISK_EVENT_STATES.filter((s) => RISK_EVENT_TRANSITIONS[s].includes("VERIFIED"))).toEqual(
      ["VERIFYING"],
    );
    expect(CASE_STATES.filter((s) => CASE_TRANSITIONS[s].includes("VERIFIED_IMPROVED"))).toEqual([
      "VERIFYING",
    ]);
  });

  it("reporting an action moves the event to ACTION_REPORTED and nothing further", () => {
    const { c, e } = reported();
    expect(e.state).toBe("ACTION_REPORTED");
    expect(c.state).toBe("ACTION_REPORTED");
    expect(e.latestVerificationId).toBeUndefined();
    expect(c.latestVerificationId).toBeUndefined();
  });

  it("completing verification straight from ACTION_REPORTED is illegal", () => {
    const { c, e } = reported();
    const r = completeVerification({
      case: c,
      event: e,
      assessment: sampleAssessment({ caseId: "CASE-1", eventId: "EVT-1" }),
      at: T(10),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });
});

describe("startVerification coordinator", () => {
  it("moves case and event to VERIFYING together", () => {
    const { c, e } = reported();
    const r = startVerification({ case: c, event: e, at: T(5) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.case.state).toBe("VERIFYING");
      expect(r.value.event.state).toBe("VERIFYING");
      expect(r.value.caseRecord).toMatchObject({ from: "ACTION_REPORTED", to: "VERIFYING" });
      expect(r.value.eventRecord).toMatchObject({ from: "ACTION_REPORTED", to: "VERIFYING" });
    }
  });

  it("returns nothing when either side cannot move (no partial transition)", () => {
    const { c, e } = reported();
    const acknowledged = { ...e, state: "ACKNOWLEDGED" as const };
    expect(startVerification({ case: c, event: acknowledged, at: T(5) }).ok).toBe(false);
    expect(startVerification({ case: { ...c, state: "OPEN" }, event: e, at: T(5) }).ok).toBe(false);
  });

  it("rejects an event that is not the active event of the case", () => {
    const { c, e } = reported();
    const r = startVerification({ case: c, event: { ...e, eventId: "EVT-OTHER" }, at: T(5) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VERIFICATION_MISMATCH");
  });

  it("an outcome flows to both aggregates and records the verification id", () => {
    const { c, e } = reported();
    const started = startVerification({ case: c, event: e, at: T(5) });
    if (!started.ok) throw new Error("start");
    const done = completeVerification({
      case: started.value.case,
      event: started.value.event,
      assessment: sampleAssessment({ caseId: "CASE-1", eventId: "EVT-1", result: "NOT_IMPROVING" }),
      at: T(9),
    });
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.value.case).toMatchObject({
        state: "NOT_IMPROVING",
        latestVerificationId: "VER-1",
      });
      expect(done.value.event).toMatchObject({
        state: "NOT_IMPROVING",
        latestVerificationId: "VER-1",
      });
    }
  });
});

describe("recurrence coordinator after a verified improvement", () => {
  it("reopens the same case with a new event and a higher count, preserving the old event", () => {
    const { c, e } = reported();
    const s = startVerification({ case: c, event: e, at: T(5) });
    if (!s.ok) throw new Error("start");
    const v = completeVerification({
      case: s.value.case,
      event: s.value.event,
      assessment: sampleAssessment({ caseId: "CASE-1", eventId: "EVT-1" }),
      at: T(9),
    });
    if (!v.ok) throw new Error("verify");
    const fresh = createRiskEvent({
      eventId: "EVT-2",
      caseId: "CASE-1",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      assetIds: ["AST-1"],
      detectedAt: T(20),
    });
    if (!fresh.ok) throw new Error("fresh");
    const r = reopenOnRecurrence({ case: v.value.case, newEvent: fresh.value, at: T(20) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.case).toMatchObject({
        caseId: "CASE-1",
        state: "REOPENED",
        recurrenceCount: 1,
        activeRiskEventId: "EVT-2",
        latestVerificationId: "VER-1",
      });
    }
    expect(v.value.event.state).toBe("VERIFIED");
  });
});
