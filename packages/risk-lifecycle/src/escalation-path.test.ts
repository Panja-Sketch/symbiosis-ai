import { describe, expect, it } from "vitest";
import { RISK_EVENT_STATES } from "@symbiosis/contracts";
import { RISK_EVENT_TRANSITIONS, applyRiskEventCommand, createRiskEvent } from "./index";
import type { RiskEventCommand } from "./index";

const T = (n: number) => `2026-01-02T00:${String(n).padStart(2, "0")}:00Z`;
const fresh = () => {
  const r = createRiskEvent({
    eventId: "RE-1",
    caseId: "CASE-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    assetIds: ["A"],
    detectedAt: "2026-01-01T00:00:00Z",
  });
  if (!r.ok) throw new Error("fixture");
  return r.value;
};
const step = (e: ReturnType<typeof fresh>, c: RiskEventCommand) => {
  const r = applyRiskEventCommand(e, c);
  if (!r.ok) throw new Error(r.error.code);
  return r.value.value;
};

describe("S4 lifecycle adjustment: DETECTED may escalate (alert never delivered)", () => {
  it("DETECTED -> ESCALATED is allowed and recorded", () => {
    const r = applyRiskEventCommand(fresh(), { type: "ESCALATE", at: T(1) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.record).toMatchObject({ from: "DETECTED", to: "ESCALATED" });
  });

  it("an event escalated before it was ever alerted can still be acknowledged and acted on", () => {
    let e = step(fresh(), { type: "ESCALATE", at: T(1) });
    e = step(e, { type: "ACKNOWLEDGE", at: T(2), actorId: "U" });
    e = step(e, { type: "REPORT_ACTION", at: T(3), actorId: "U", actionId: "ACT-1" });
    expect(e.state).toBe("ACTION_REPORTED");
  });

  it("is the only S4 change to the table: nothing new reaches a verification state", () => {
    expect(RISK_EVENT_TRANSITIONS.DETECTED).toEqual([
      "ALERTED",
      "ESCALATED",
      "SELF_RESOLVED",
      "DISMISSED_FALSE_ALARM",
    ]);
    const sources = RISK_EVENT_STATES.filter((s) => RISK_EVENT_TRANSITIONS[s].includes("VERIFIED"));
    expect(sources).toEqual(["VERIFYING"]);
    expect(RISK_EVENT_TRANSITIONS.ACTION_REPORTED).toEqual(["VERIFYING"]);
    expect(RISK_EVENT_TRANSITIONS.ESCALATED).toEqual([
      "ACKNOWLEDGED",
      "SELF_RESOLVED",
      "DISMISSED_FALSE_ALARM",
    ]);
  });

  it("ALERTED and ACKNOWLEDGED behavior is unchanged (acknowledged events do not escalate)", () => {
    const acked = step(step(fresh(), { type: "ALERT", at: T(1) }), {
      type: "ACKNOWLEDGE",
      at: T(2),
      actorId: "U",
    });
    const r = applyRiskEventCommand(acked, { type: "ESCALATE", at: T(3) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
  });
});
