import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Alert, CaseSeverity, RiskDetection } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import {
  InMemoryAlertRepository,
  InMemoryCaseRepository,
  InMemoryRiskEventRepository,
} from "@symbiosis/repositories";
import { applyRiskEventCommand, openCaseFromDetection } from "@symbiosis/risk-lifecycle";
import type { RiskEventCommand } from "@symbiosis/risk-lifecycle";
import { acknowledgementDeadlineSeconds, parseEscalationPolicy, runEscalationTick } from "./index";
import type { EscalationDeps, EscalationPolicy } from "./index";

const policy: EscalationPolicy = parseEscalationPolicy(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "config", "escalation", "escalation.v1.json"),
      "utf8",
    ),
  ),
);

const T0 = "2026-10-01T00:00:00.000Z";
const SENT_AT = "2026-10-01T00:05:00.000Z";
const sentMs = Date.parse(SENT_AT);

const detection = (severity: CaseSeverity): RiskDetection => ({
  detectionId: "DET-1",
  organizationId: "ORG-SIM-001",
  facilityId: "FAC-SIM-001",
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-SIM-FAN-A",
  contextAssetIds: [],
  severity,
  confidence: 1,
  detectedAt: T0,
  reasonCodes: [],
  supportingObservationIds: [],
  baselineIds: [],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: {},
});

let clock: ManualClock;
let bus: InMemoryBus;
let alerts: InMemoryAlertRepository;
let cases: InMemoryCaseRepository;
let riskEvents: InMemoryRiskEventRepository;
let audit: InMemoryAuditLog;
let requested: { caseId: string; eventState: string; correlationId: string }[];
let deps: EscalationDeps;

beforeEach(() => {
  clock = new ManualClock(sentMs);
  bus = new InMemoryBus();
  alerts = new InMemoryAlertRepository();
  cases = new InMemoryCaseRepository();
  riskEvents = new InMemoryRiskEventRepository();
  audit = new InMemoryAuditLog();
  requested = [];
  deps = {
    alerts,
    cases,
    riskEvents,
    audit,
    bus,
    ids: new SequentialIdGenerator(),
    clock,
    policy,
    requestEscalationAlert: async ({ caseRecord, event, correlationId }) => {
      requested.push({ caseId: caseRecord.caseId, eventState: event.state, correlationId });
    },
  };
});

/** An alerted (or otherwise advanced) risk event with its sent initial alert. */
async function world(
  severity: CaseSeverity,
  commands: RiskEventCommand[] = [{ type: "ALERT", at: SENT_AT }],
  alertOver: Partial<Alert> = {},
) {
  const opened = openCaseFromDetection({
    detection: detection(severity),
    caseId: "CASE-1",
    eventId: "RE-1",
    baselineSnapshotId: "B",
  });
  if (!opened.ok) throw new Error("fixture");
  let event = opened.value.event;
  for (const c of commands) {
    const r = applyRiskEventCommand(event, c);
    if (!r.ok) throw new Error(r.error.code);
    event = r.value.value;
  }
  await cases.save(opened.value.case);
  await riskEvents.save(event);
  const alert: Alert = {
    alertId: "ALR-RE-1-INITIAL",
    organizationId: "ORG-SIM-001",
    facilityId: "FAC-SIM-001",
    caseId: "CASE-1",
    riskEventId: "RE-1",
    kind: "INITIAL",
    severity,
    hazardType: "COOLING_ELECTRICAL_DETERIORATION",
    reasonCodes: [],
    summary: "s",
    recipient: { ref: "USR-FACILITY-MGR-001", role: "FACILITY_MANAGER" },
    channel: "CONSOLE_EMAIL",
    status: "SENT",
    attempts: [],
    maxAttempts: 3,
    exhausted: false,
    requestedAt: T0,
    sentAt: SENT_AT,
    correlationId: "CORR-1",
    ...alertOver,
  };
  await alerts.save(alert);
  return { alert };
}

const state = async () => (await riskEvents.get("ORG-SIM-001", "RE-1"))?.state;

describe("escalation policy", () => {
  it("is versioned configuration with a deadline per severity (no timeouts in code)", () => {
    expect(policy.version).toBe("escalation.v1");
    expect(acknowledgementDeadlineSeconds(policy, "MODERATE")).toBe(900);
    expect(acknowledgementDeadlineSeconds(policy, "CRITICAL")).toBeLessThan(
      acknowledgementDeadlineSeconds(policy, "LOW"),
    );
    expect(policy.alert.maxDeliveryAttempts).toBe(3);
  });

  it("rejects malformed policies", () => {
    expect(() => parseEscalationPolicy({})).toThrow();
    expect(() =>
      parseEscalationPolicy({
        ...policy,
        alert: { ...policy.alert, initialRecipientRole: "KING" },
      }),
    ).toThrow();
    expect(() =>
      parseEscalationPolicy({ ...policy, acknowledgementDeadlineSeconds: { LOW: 1 } }),
    ).toThrow();
    expect(() =>
      parseEscalationPolicy({ ...policy, alert: { ...policy.alert, maxDeliveryAttempts: 0 } }),
    ).toThrow();
  });
});

describe("runEscalationTick", () => {
  it("does not escalate before the acknowledgement deadline", async () => {
    await world("MODERATE");
    clock.advance(899_000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    expect(await state()).toBe("ALERTED");
    expect(bus.history()).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("escalates once the deadline is reached: ESCALATED, risk.escalated, audit, escalation notification", async () => {
    const { alert } = await world("MODERATE");
    clock.advance(900_000);
    const r = await runEscalationTick(deps);
    expect(r.escalated).toEqual([{ riskEventId: "RE-1", caseId: "CASE-1" }]);
    expect(await state()).toBe("ESCALATED");
    const ev = bus.history()[0];
    expect(ev?.event_type).toBe("risk.escalated.v1");
    expect(ev?.event_type === "risk.escalated.v1" && ev.payload).toMatchObject({
      caseId: "CASE-1",
      riskEventId: "RE-1",
      reason: "ACKNOWLEDGEMENT_OVERDUE",
      acknowledgementDeadlineSeconds: 900,
      previousState: "ALERTED",
    });
    expect(ev?.correlation_id).toBe("CORR-1");
    expect(requested).toEqual([
      { caseId: "CASE-1", eventState: "ESCALATED", correlationId: "CORR-1" },
    ]);
    expect((await audit.list("ORG-SIM-001")).at(-1)).toMatchObject({
      action: "RISK_ESCALATED",
      actorType: "SYSTEM",
      beforeState: "ALERTED",
      afterState: "ESCALATED",
    });
    // the original alert is preserved untouched
    expect(await alerts.get("ORG-SIM-001", alert.alertId)).toEqual(alert);
  });

  it("escalation does not change the physical severity", async () => {
    await world("MODERATE");
    clock.advance(900_000);
    await runEscalationTick(deps);
    expect((await cases.get("ORG-SIM-001", "CASE-1"))?.severity).toBe("MODERATE");
  });

  it("uses the severity-specific deadline", async () => {
    await world("CRITICAL");
    clock.advance(119_000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    clock.advance(1_000);
    expect((await runEscalationTick(deps)).escalated).toHaveLength(1);
  });

  it("never escalates an acknowledged event, however long it waits", async () => {
    await world("CRITICAL", [
      { type: "ALERT", at: SENT_AT },
      { type: "ACKNOWLEDGE", at: "2026-10-01T00:05:30.000Z", actorId: "USR-FACILITY-MGR-001" },
    ]);
    clock.advance(24 * 3600 * 1000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    expect(await state()).toBe("ACKNOWLEDGED");
    expect(requested).toEqual([]);
  });

  it("does not escalate events that already have a reported action", async () => {
    await world("CRITICAL", [
      { type: "ALERT", at: SENT_AT },
      { type: "ACKNOWLEDGE", at: "2026-10-01T00:05:30.000Z", actorId: "U" },
      { type: "REPORT_ACTION", at: "2026-10-01T00:06:00.000Z", actorId: "U", actionId: "ACT-1" },
    ]);
    clock.advance(3600_000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
  });

  it("escalates only once: a second tick finds the event already ESCALATED", async () => {
    await world("HIGH");
    clock.advance(10_000_000);
    expect((await runEscalationTick(deps)).escalated).toHaveLength(1);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    expect(requested).toHaveLength(1);
    expect(bus.history().filter((e) => e.event_type === "risk.escalated.v1")).toHaveLength(1);
  });

  it("does not escalate an alert that was never delivered unless it is exhausted", async () => {
    await world("HIGH", [], { status: "FAILED", exhausted: false, sentAt: undefined as never });
    clock.advance(10_000_000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    expect(await state()).toBe("DETECTED");
  });

  it("escalates a still-DETECTED event whose alert delivery is exhausted, so a human is reached", async () => {
    await world("HIGH", [], { status: "FAILED", exhausted: true });
    const r = await runEscalationTick(deps);
    expect(r.escalated).toHaveLength(1);
    expect(await state()).toBe("ESCALATED");
    const ev = bus.history()[0];
    expect(ev?.event_type === "risk.escalated.v1" && ev.payload).toMatchObject({
      reason: "ALERT_DELIVERY_EXHAUSTED",
      previousState: "DETECTED",
    });
  });

  it("ignores escalation alerts and unknown cases or events", async () => {
    await world("MODERATE", [{ type: "ALERT", at: SENT_AT }], { kind: "ESCALATION" });
    clock.advance(10_000_000);
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
    await alerts.save({
      ...(await alerts.get("ORG-SIM-001", "ALR-RE-1-INITIAL"))!,
      alertId: "ALR-GHOST",
      kind: "INITIAL",
      riskEventId: "RE-GHOST",
    });
    expect((await runEscalationTick(deps)).escalated).toEqual([]);
  });

  it("is deterministic: the same state and clock produce the same result", async () => {
    await world("MODERATE");
    clock.advance(900_000);
    const a = await runEscalationTick(deps);
    expect(a.escalated).toHaveLength(1);
    // a fresh identical world and clock reproduces the identical outcome
    const bus2 = new InMemoryBus();
    const alerts2 = new InMemoryAlertRepository();
    const cases2 = new InMemoryCaseRepository();
    const events2 = new InMemoryRiskEventRepository();
    const opened = openCaseFromDetection({
      detection: detection("MODERATE"),
      caseId: "CASE-1",
      eventId: "RE-1",
      baselineSnapshotId: "B",
    });
    if (!opened.ok) throw new Error("fixture");
    const alerted = applyRiskEventCommand(opened.value.event, { type: "ALERT", at: SENT_AT });
    if (!alerted.ok) throw new Error("fixture");
    await cases2.save(opened.value.case);
    await events2.save(alerted.value.value);
    await alerts2.save((await alerts.get("ORG-SIM-001", "ALR-RE-1-INITIAL"))!);
    const b = await runEscalationTick({
      ...deps,
      alerts: alerts2,
      cases: cases2,
      riskEvents: events2,
      bus: bus2,
      audit: new InMemoryAuditLog(),
      ids: new SequentialIdGenerator(),
    });
    expect(b).toEqual(a);
  });
});
