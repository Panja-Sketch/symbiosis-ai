import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RiskDetection } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { parseEscalationPolicy } from "@symbiosis/escalation";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import {
  InMemoryAlertRepository,
  InMemoryCaseRepository,
  InMemoryRiskEventRepository,
} from "@symbiosis/repositories";
import { openCaseFromDetection } from "@symbiosis/risk-lifecycle";
import { createSyntheticActorDirectory, InMemoryActorDirectory } from "@symbiosis/tenancy";
import { ScriptedNotificationSender } from "./testing";
import {
  ConsoleEmail,
  composeAlert,
  createAlerting,
  describeReasonCodes,
  startAlerting,
} from "./index";
import type { Alerting, AlertingDeps } from "./index";

const policy = parseEscalationPolicy(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "config", "escalation", "escalation.v1.json"),
      "utf8",
    ),
  ),
);

const detection: RiskDetection = {
  detectionId: "DET-1",
  organizationId: "ORG-SIM-001",
  facilityId: "FAC-SIM-001",
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-SIM-FAN-A",
  contextAssetIds: ["AST-SIM-OUTDOOR"],
  severity: "HIGH",
  confidence: 1,
  detectedAt: "2026-10-01T00:00:00.000Z",
  reasonCodes: ["VIBRATION_Z_AT_OR_ABOVE_THRESHOLD", "OUTDOOR_HEAT_CONTEXT", "PERSISTED_3_OF_3"],
  supportingObservationIds: [],
  baselineIds: [],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: { vibrationZ: 8.5 },
};

let clock: ManualClock;
let bus: InMemoryBus;
let alerts: InMemoryAlertRepository;
let cases: InMemoryCaseRepository;
let riskEvents: InMemoryRiskEventRepository;
let audit: InMemoryAuditLog;
let ids: SequentialIdGenerator;

beforeEach(() => {
  clock = new ManualClock(Date.parse("2026-10-01T00:00:30Z"));
  bus = new InMemoryBus();
  alerts = new InMemoryAlertRepository();
  cases = new InMemoryCaseRepository();
  riskEvents = new InMemoryRiskEventRepository();
  audit = new InMemoryAuditLog();
  ids = new SequentialIdGenerator();
});

async function setup(
  sender: ScriptedNotificationSender,
  directory = createSyntheticActorDirectory(),
) {
  const opened = openCaseFromDetection({
    detection,
    caseId: "CASE-1",
    eventId: "RE-1",
    baselineSnapshotId: "B",
  });
  if (!opened.ok) throw new Error("fixture");
  await cases.save(opened.value.case);
  await riskEvents.save(opened.value.event);
  const deps: AlertingDeps = {
    bus,
    ids,
    clock,
    alerts,
    cases,
    riskEvents,
    audit,
    directory,
    sender,
    policy,
  };
  const alerting = createAlerting(deps);
  return { alerting, deps, caseRecord: opened.value.case, event: opened.value.event };
}

const request = (
  a: Alerting,
  c: Awaited<ReturnType<typeof setup>>,
  kind: "INITIAL" | "ESCALATION" = "INITIAL",
) =>
  a.requestAlert({
    caseRecord: c.caseRecord,
    event: c.event,
    kind,
    correlationId: "CORR-1",
    causationId: "EVT-CASE",
    reasonCodes: detection.reasonCodes,
  });

const types = () => bus.history().map((e) => e.event_type as string);
const eventState = async () => (await riskEvents.get("ORG-SIM-001", "RE-1"))?.state;

describe("alert content", () => {
  const c = openCaseFromDetection({
    detection,
    caseId: "CASE-1",
    eventId: "RE-1",
    baselineSnapshotId: "B",
  });
  const caseRecord = c.ok ? c.value.case : (undefined as never);

  it("is deterministic and carries case, event, severity, hazard, assets, reasons and a local path", () => {
    const a = composeAlert({
      caseRecord,
      kind: "INITIAL",
      reasonCodes: detection.reasonCodes,
      casePath: "/ui/cases/CASE-1",
    });
    const again = composeAlert({
      caseRecord,
      kind: "INITIAL",
      reasonCodes: detection.reasonCodes,
      casePath: "/ui/cases/CASE-1",
    });
    expect(a).toEqual(again);
    expect(a.subject).toContain("[ALERT]");
    expect(a.subject).toContain("[HIGH]");
    for (const needle of [
      "CASE-1",
      "RE-1",
      "COOLING_ELECTRICAL_DETERIORATION",
      "FAC-SIM-001",
      "AST-SIM-FAN-A",
      "/ui/cases/CASE-1",
      "vibration is well above its learned baseline",
    ]) {
      expect(a.body).toContain(needle);
    }
  });

  it("says a report is not proof of improvement, and never claims verification", () => {
    const a = composeAlert({ caseRecord, kind: "INITIAL", reasonCodes: [], casePath: "/p" });
    expect(a.body).toContain("not proof");
    expect(a.body).not.toMatch(/verified/i);
  });

  it("contains no raw telemetry, tokens or secrets", () => {
    const a = composeAlert({
      caseRecord,
      kind: "ESCALATION",
      reasonCodes: detection.reasonCodes,
      casePath: "/ui/cases/CASE-1",
    });
    expect(a.subject).toContain("[ESCALATION]");
    expect(a.body).not.toMatch(/token|secret|password|key=|vibrationZ|8\.5/i);
  });

  it("turns known codes into plain phrases and keeps unknown codes visible", () => {
    expect(describeReasonCodes(["PERSISTED_3_OF_3", "SOMETHING_NEW"])).toEqual([
      "the condition persisted for 3 of 3 required checks",
      "SOMETHING_NEW",
    ]);
  });
});

describe("ConsoleEmail (local channel)", () => {
  const req = {
    notificationId: "NTF-1",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    channel: "CONSOLE_EMAIL" as const,
    recipient: { ref: "USR-FACILITY-MGR-001", role: "FACILITY_MANAGER" },
    subject: "[ALERT] x",
    body: "line one\nline two",
    caseId: "CASE-1",
    riskEventId: "RE-1",
    severity: "HIGH" as const,
    requestedAt: "2026-10-01T00:00:30.000Z",
  };

  it("writes recipient, subject and body to the sink and returns SENT with timestamps", async () => {
    const lines: string[] = [];
    const email = new ConsoleEmail(clock, (l) => lines.push(l));
    const r = await email.send(req);
    expect(r).toEqual({
      notificationId: "NTF-1",
      status: "SENT",
      channel: "CONSOLE_EMAIL",
      recipientRef: "USR-FACILITY-MGR-001",
      requestedAt: "2026-10-01T00:00:30.000Z",
      completedAt: "2026-10-01T00:00:30.000Z",
    });
    expect(lines.join("\n")).toContain("To: USR-FACILITY-MGR-001 (FACILITY_MANAGER)");
    expect(lines.join("\n")).toContain("nothing was emailed");
  });

  it("fails explicitly for an empty recipient and sends nothing", async () => {
    const lines: string[] = [];
    const r = await new ConsoleEmail(clock, (l) => lines.push(l)).send({
      ...req,
      recipient: { ref: " " },
    });
    expect(r.status).toBe("FAILED");
    expect(r.failure?.code).toBe("INVALID_RECIPIENT");
    expect(lines).toEqual([]);
  });

  it("the scripted test double replays outcomes and records requests", async () => {
    const s = new ScriptedNotificationSender(clock, ["FAILED", "SENT"]);
    expect((await s.send(req)).status).toBe("FAILED");
    expect((await s.send(req)).status).toBe("SENT");
    expect((await s.send(req)).status).toBe("SENT");
    expect(s.requests).toHaveLength(3);
    await expect(new ScriptedNotificationSender(clock, ["THROW"]).send(req)).rejects.toThrow();
  });
});

describe("alerting: successful delivery", () => {
  it("requests, sends and only then moves the event to ALERTED, in order, with an audit trail", async () => {
    const sender = new ScriptedNotificationSender(clock, ["SENT"]);
    const w = await setup(sender);
    const alert = await request(w.alerting, w);
    expect(alert).toMatchObject({
      status: "SENT",
      kind: "INITIAL",
      caseId: "CASE-1",
      riskEventId: "RE-1",
      severity: "HIGH",
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      organizationId: "ORG-SIM-001",
      facilityId: "FAC-SIM-001",
      recipient: { ref: "USR-FACILITY-MGR-001", role: "FACILITY_MANAGER" },
      channel: "CONSOLE_EMAIL",
      correlationId: "CORR-1",
    });
    expect(alert.reasonCodes).toEqual(detection.reasonCodes);
    expect(alert.attempts).toHaveLength(1);
    expect(types()).toEqual([
      "risk.alert_requested.v1",
      "notification.requested.v1",
      "notification.sent.v1",
      "risk.alerted.v1",
    ]);
    expect(await eventState()).toBe("ALERTED");
    const requested = bus.history()[0];
    expect(requested?.event_type === "risk.alert_requested.v1" && requested.causation_id).toBe(
      "EVT-CASE",
    );
    expect(requested?.correlation_id).toBe("CORR-1");
    const chain = bus.history();
    expect(chain[1]?.causation_id).toBe(chain[0]?.event_id);
    expect(chain[2]?.causation_id).toBe(chain[1]?.event_id);
    expect(chain[3]?.causation_id).toBe(chain[2]?.event_id);
    expect((await audit.list("ORG-SIM-001")).map((e) => e.action)).toEqual([
      "ALERT_REQUESTED",
      "ALERT_SENT",
      "RISK_ALERTED",
    ]);
    expect(sender.requests[0]?.body).toContain("CASE-1");
  });

  it("an alert request alone (before any send) does not mark the event ALERTED", async () => {
    const sender = new ScriptedNotificationSender(clock, ["FAILED"]);
    const w = await setup(sender);
    await request(w.alerting, w);
    expect(types()).not.toContain("risk.alerted.v1");
    expect(await eventState()).toBe("DETECTED");
  });

  it("duplicate processing creates no second alert, notification or transition", async () => {
    const sender = new ScriptedNotificationSender(clock, ["SENT"]);
    const w = await setup(sender);
    await request(w.alerting, w);
    const again = await request(w.alerting, w);
    expect(again.alertId).toBe("ALR-RE-1-INITIAL");
    expect(sender.requests).toHaveLength(1);
    expect(types().filter((t) => t === "risk.alert_requested.v1")).toHaveLength(1);
    expect((await alerts.listByCase("ORG-SIM-001", "CASE-1")).length).toBe(1);
  });

  it("starts from case.created and uses the detection's reason codes", async () => {
    const sender = new ScriptedNotificationSender(clock, ["SENT"]);
    const w = await setup(sender);
    startAlerting(w.deps, w.alerting);
    const { createEnvelope } = await import("@symbiosis/event-bus");
    const base = {
      correlationId: "CORR-9",
      organizationId: "ORG-SIM-001",
      facilityId: "FAC-SIM-001",
      occurredAt: "2026-10-01T00:00:00.000Z",
      producer: "worker" as const,
    };
    await bus.publish(
      createEnvelope(ids, {
        ...base,
        type: "risk.detected.v1",
        causationId: null,
        payload: detection,
      }),
    );
    await bus.publish(
      createEnvelope(ids, {
        ...base,
        type: "case.created.v1",
        causationId: null,
        payload: {
          caseId: "CASE-1",
          riskEventId: "RE-1",
          detectionId: "DET-1",
          hazardType: detection.hazardType,
          severity: "HIGH" as const,
          state: "OPEN" as const,
          assetIds: ["AST-SIM-FAN-A"],
          baselineSnapshotId: "B",
        },
      }),
    );
    const [alert] = await alerts.listByCase("ORG-SIM-001", "CASE-1");
    expect(alert?.reasonCodes).toEqual(detection.reasonCodes);
    expect(await eventState()).toBe("ALERTED");
    // delivering the same case.created again changes nothing
    await bus.publish(
      createEnvelope(ids, {
        ...base,
        type: "case.created.v1",
        causationId: null,
        payload: {
          caseId: "CASE-1",
          riskEventId: "RE-1",
          detectionId: "DET-1",
          hazardType: detection.hazardType,
          severity: "HIGH" as const,
          state: "OPEN" as const,
          assetIds: [],
          baselineSnapshotId: "B",
        },
      }),
    );
    expect(sender.requests).toHaveLength(1);
  });
});

describe("alerting: failure and retry", () => {
  it("a failed attempt preserves failure evidence and does not claim delivery", async () => {
    const sender = new ScriptedNotificationSender(clock, ["FAILED"]);
    const w = await setup(sender);
    const alert = await request(w.alerting, w);
    expect(alert.status).toBe("FAILED");
    expect(alert.sentAt).toBeUndefined();
    expect(alert.exhausted).toBe(false);
    expect(alert.attempts[0]).toMatchObject({
      status: "FAILED",
      failure: { code: "SCRIPTED_FAILURE" },
    });
    expect(alert.nextRetryAt).toBe("2026-10-01T00:01:30.000Z"); // completed 00:00:30 + 60 s
    expect(types()).toEqual([
      "risk.alert_requested.v1",
      "notification.requested.v1",
      "notification.failed.v1",
    ]);
    expect(await eventState()).toBe("DETECTED");
    const failed = bus.history().at(-1);
    expect(failed?.event_type === "notification.failed.v1" && failed.payload.nextRetryAt).toBe(
      "2026-10-01T00:01:30.000Z",
    );
    expect((await audit.list("ORG-SIM-001")).map((e) => e.action)).toContain("ALERT_FAILED");
  });

  it("a later retry can succeed without duplicating the alert, case or event state", async () => {
    const sender = new ScriptedNotificationSender(clock, ["FAILED", "SENT"]);
    const w = await setup(sender);
    await request(w.alerting, w);
    expect(await w.alerting.retryDueAlerts()).toBe(0); // not due yet
    clock.advance(59_000);
    expect(await w.alerting.retryDueAlerts()).toBe(0);
    clock.advance(1_000);
    expect(await w.alerting.retryDueAlerts()).toBe(1);
    const [alert] = await alerts.listByCase("ORG-SIM-001", "CASE-1");
    expect(alert).toMatchObject({ status: "SENT", exhausted: false });
    expect(alert?.attempts.map((a) => a.status)).toEqual(["FAILED", "SENT"]);
    expect(await eventState()).toBe("ALERTED");
    expect((await alerts.listByCase("ORG-SIM-001", "CASE-1")).length).toBe(1);
    expect(types().filter((t) => t === "risk.alerted.v1")).toHaveLength(1);
    expect(await w.alerting.retryDueAlerts()).toBe(0); // nothing left to retry
    expect((await cases.list("ORG-SIM-001")).length).toBe(1);
  });

  it("stops after the maximum attempts and marks the alert exhausted (event stays DETECTED)", async () => {
    const sender = new ScriptedNotificationSender(clock, ["FAILED"]);
    const w = await setup(sender);
    await request(w.alerting, w);
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      await w.alerting.retryDueAlerts();
    }
    const [alert] = await alerts.listByCase("ORG-SIM-001", "CASE-1");
    expect(alert).toMatchObject({ status: "FAILED", exhausted: true });
    expect(alert?.attempts).toHaveLength(3);
    expect(alert?.nextRetryAt).toBeUndefined();
    expect(sender.requests).toHaveLength(3);
    expect(await eventState()).toBe("DETECTED");
  });

  it("a sender that throws is recorded as a FAILED attempt, not an unhandled error", async () => {
    const sender = new ScriptedNotificationSender(clock, ["THROW"]);
    const w = await setup(sender);
    const alert = await request(w.alerting, w);
    expect(alert.status).toBe("FAILED");
    expect(alert.attempts[0]?.failure?.code).toBe("SENDER_ERROR");
    expect(await eventState()).toBe("DETECTED");
  });

  it("with no actor holding the configured role the alert fails without calling the sender", async () => {
    const sender = new ScriptedNotificationSender(clock, ["SENT"]);
    const w = await setup(sender, new InMemoryActorDirectory([]));
    const alert = await request(w.alerting, w);
    expect(alert.recipient.ref).toBe("UNASSIGNED");
    expect(alert.status).toBe("FAILED");
    expect(alert.attempts[0]?.failure?.code).toBe("NO_RECIPIENT");
    expect(sender.requests).toHaveLength(0);
    expect(await eventState()).toBe("DETECTED");
  });
});

describe("alerting: escalation alerts", () => {
  it("are separate alerts to the escalation role and never re-alert the event", async () => {
    const sender = new ScriptedNotificationSender(clock, ["SENT"]);
    const w = await setup(sender);
    const initial = await request(w.alerting, w);
    const escalated = await request(w.alerting, w, "ESCALATION");
    expect(initial.alertId).not.toBe(escalated.alertId);
    expect(escalated).toMatchObject({
      kind: "ESCALATION",
      recipient: { role: "ORG_ADMIN", ref: "USR-ORG-ADMIN-001" },
      status: "SENT",
    });
    expect(await alerts.listByCase("ORG-SIM-001", "CASE-1")).toHaveLength(2);
    expect(types().filter((t) => t === "risk.alerted.v1")).toHaveLength(1);
    expect(sender.requests[1]?.subject).toContain("[ESCALATION]");
  });
});
