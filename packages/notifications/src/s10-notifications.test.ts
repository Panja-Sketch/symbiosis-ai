import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RiskDetection, VerificationAttempt, VerificationResult } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { parseEscalationPolicy } from "@symbiosis/escalation";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import {
  InMemoryActionRepository,
  InMemoryAlertRepository,
  InMemoryCaseRepository,
  InMemoryRiskEventRepository,
  InMemoryTenantDocumentStore,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import { openCaseFromDetection } from "@symbiosis/risk-lifecycle";
import { createSyntheticActorDirectory } from "@symbiosis/tenancy";
import { sampleAssessment } from "@symbiosis/verification/testing";
import {
  StoreContactDirectory,
  StoreDeliveryStore,
  alertIdFor,
  composeAlert,
  createAlerting,
  createFollowUps,
  isValidEmail,
  maskEmail,
  parseFollowUpPolicy,
  startAlerting,
} from "./index";
import type { FollowUpPolicy } from "./index";
import { ScriptedNotificationSender } from "./testing";

const root = join(import.meta.dirname, "..", "..", "..", "config");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8")) as unknown;
const escalation = parseEscalationPolicy(json("escalation/escalation.v1.json"));
const followPolicy = parseFollowUpPolicy(json("notifications/follow-up.v1.json"));

const ORG = "ORG-SIM-001";
const detection: RiskDetection = {
  detectionId: "DET-1",
  organizationId: ORG,
  facilityId: "FAC-SIM-001",
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-SIM-FAN-A",
  contextAssetIds: [],
  severity: "HIGH",
  confidence: 1,
  detectedAt: "2026-10-02T10:00:00.000Z",
  reasonCodes: ["VIBRATION_Z_AT_OR_ABOVE_THRESHOLD", "PERSISTED_3_OF_3"],
  supportingObservationIds: [],
  baselineIds: [],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: {},
};

async function world(
  outcomes: ConstructorParameters<typeof ScriptedNotificationSender>[1] = ["SENT"],
  policy: FollowUpPolicy = followPolicy,
) {
  const clock = new ManualClock(Date.parse("2026-10-02T10:00:30Z"));
  const bus = new InMemoryBus();
  const alerts = new InMemoryAlertRepository();
  const cases = new InMemoryCaseRepository();
  const riskEvents = new InMemoryRiskEventRepository();
  const actions = new InMemoryActionRepository();
  const verifications = new InMemoryVerificationRepository();
  const audit = new InMemoryAuditLog();
  const store = new InMemoryTenantDocumentStore();
  const ids = new SequentialIdGenerator();
  const sender = new ScriptedNotificationSender(clock, outcomes);
  const opened = openCaseFromDetection({
    detection,
    caseId: "CASE-1",
    eventId: "RE-1",
    baselineSnapshotId: "B",
  });
  if (!opened.ok) throw new Error("fixture");
  await cases.save(opened.value.case);
  await riskEvents.save(opened.value.event);
  const deliveries = new StoreDeliveryStore(store);
  const deps = {
    bus,
    ids,
    clock,
    alerts,
    cases,
    riskEvents,
    audit,
    directory: createSyntheticActorDirectory(),
    sender,
    policy: escalation,
    deliveries,
  };
  const alerting = createAlerting(deps);
  const followUps = createFollowUps({
    ids,
    clock,
    audit,
    cases,
    riskEvents,
    actions,
    verifications,
    alerts,
    alerting,
    store,
    policy,
  });
  const c = opened.value.case;
  const e = opened.value.event;
  return {
    clock,
    bus,
    alerts,
    cases,
    riskEvents,
    actions,
    verifications,
    audit,
    store,
    sender,
    alerting,
    followUps,
    deliveries,
    c,
    e,
    deps,
  };
}
type W = Awaited<ReturnType<typeof world>>;

const initial = (w: W) =>
  w.alerting.requestAlert({
    caseRecord: w.c,
    event: w.e,
    kind: "INITIAL",
    correlationId: "CORR-1",
    causationId: "EVT-1",
    reasonCodes: detection.reasonCodes,
  });

describe("delivery idempotency", () => {
  it("a redelivered request sends once and persists one delivery record", async () => {
    const w = await world();
    const a = await initial(w);
    const b = await initial(w);
    expect(b.alertId).toBe(a.alertId);
    expect(w.sender.requests).toHaveLength(1);
    const d = await w.deliveries.listByAlert(ORG, a.alertId);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      deliveryId: `${a.alertId}#1`,
      status: "SENT",
      attempt: 1,
      alertKind: "INITIAL",
      channel: "CONSOLE_EMAIL",
    });
  });

  it("concurrent duplicate executions of the same event send exactly once", async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 5 }, () => initial(w)));
    expect(new Set(results.map((r) => r.alertId)).size).toBe(1);
    expect(w.sender.requests).toHaveLength(1);
    expect(await w.deliveries.listByAlert(ORG, results[0]?.alertId ?? "")).toHaveLength(1);
  });

  it("a duplicate case.created event never produces a second email", async () => {
    const w = await world();
    startAlerting(w.deps, w.alerting);
    const { createEnvelope } = await import("@symbiosis/event-bus");
    const mk = () =>
      createEnvelope(w.deps.ids, {
        type: "case.created.v1",
        correlationId: "CORR-1",
        causationId: null,
        organizationId: ORG,
        facilityId: "FAC-SIM-001",
        occurredAt: "2026-10-02T10:00:00.000Z",
        producer: "worker",
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
      });
    const event = mk();
    await w.bus.publish(event);
    await w.bus.publish(event); // Pub/Sub redelivery of the very same event
    await w.bus.publish(mk()); // and a re-emitted one
    expect(w.sender.requests).toHaveLength(1);
    expect((await w.alerts.listByCase(ORG, "CASE-1")).length).toBe(1);
  });

  it("repairs an attempt that was reserved and never completed, then retries it", async () => {
    const w = await world();
    const alert = await initial(w);
    // Simulate a crash between "reserve" and "result": the alert is REQUESTED, the delivery PENDING.
    await w.alerts.save({ ...alert, status: "REQUESTED", attempts: [], exhausted: false });
    const [d] = await w.deliveries.listByAlert(ORG, alert.alertId);
    await w.deliveries.complete({ ...(d as NonNullable<typeof d>), status: "PENDING" });
    w.sender.requests.length = 0;
    expect(await w.alerting.retryDueAlerts()).toBe(0); // not stuck long enough yet
    w.clock.advance(125_000);
    expect(await w.alerting.retryDueAlerts()).toBe(1);
    const ds = await w.deliveries.listByAlert(ORG, alert.alertId);
    expect(ds.map((x) => `${x.attempt}:${x.status}`).sort()).toEqual(["1:FAILED", "2:SENT"]);
    expect(ds.find((x) => x.attempt === 1)?.failure?.code).toBe("INTERRUPTED");
    expect(w.sender.requests).toHaveLength(1);
  });
});

describe("retry classification", () => {
  it("retries a transient failure on the policy interval and then succeeds", async () => {
    const w = await world(["FAILED", "SENT"]);
    const first = await initial(w);
    expect(first.status).toBe("FAILED");
    expect(first.exhausted).toBe(false);
    expect(await w.alerting.retryDueAlerts()).toBe(0);
    w.clock.advance(61_000);
    expect(await w.alerting.retryDueAlerts()).toBe(1);
    expect((await w.alerts.get(ORG, first.alertId))?.status).toBe("SENT");
    const d = await w.deliveries.listByAlert(ORG, first.alertId);
    expect(d.map((x) => x.status).sort()).toEqual(["FAILED", "SENT"]);
    expect(d.find((x) => x.status === "FAILED")?.failure).toMatchObject({ retryable: true });
  });

  it("never retries a permanent failure (a bad recipient does not get three more tries)", async () => {
    const w = await world(["FAILED_PERMANENT"]);
    const a = await initial(w);
    expect(a).toMatchObject({ status: "FAILED", exhausted: true });
    w.clock.advance(3_600_000);
    expect(await w.alerting.retryDueAlerts()).toBe(0);
    expect(w.sender.requests).toHaveLength(1);
    expect((await w.deliveries.listByAlert(ORG, a.alertId))[0]?.failure?.retryable).toBe(false);
  });

  it("stops after the configured number of attempts", async () => {
    const w = await world(["FAILED"]);
    const a = await initial(w);
    for (let i = 0; i < 6; i += 1) {
      w.clock.advance(61_000);
      await w.alerting.retryDueAlerts();
    }
    expect(w.sender.requests).toHaveLength(escalation.alert.maxDeliveryAttempts);
    expect((await w.alerts.get(ORG, a.alertId))?.exhausted).toBe(true);
  });

  it("a sender that throws is a retryable failed attempt, not an error", async () => {
    const w = await world(["THROW", "SENT"]);
    const a = await initial(w);
    expect(a.status).toBe("FAILED");
    expect((await w.deliveries.listByAlert(ORG, a.alertId))[0]?.failure?.code).toBe("SENDER_ERROR");
  });
});

describe("recurrence wording", () => {
  it("the INITIAL alert of a recurrence says the hazard returned and keeps the same alert id rules", async () => {
    const w = await world();
    const a = await w.alerting.requestAlert({
      caseRecord: { ...w.c, recurrenceCount: 1 },
      event: w.e,
      kind: "INITIAL",
      correlationId: "C",
      causationId: null,
      reasonCodes: detection.reasonCodes,
      trigger: {
        type: "RECURRENCE",
        referenceId: "RE-1",
        why: "The hazard returned after a verified improvement (recurrence 1).",
      },
    });
    expect(a.alertId).toBe(alertIdFor("RE-1", "INITIAL"));
    expect(a.trigger?.type).toBe("RECURRENCE");
    expect(w.sender.requests[0]?.subject).toMatch(/^\[RECURRENCE\]/);
    expect(w.sender.requests[0]?.body).toMatch(/risk that was verified as improved has returned/);
  });
});

const attempt = (result: VerificationResult, id = "VER-1"): VerificationAttempt => ({
  verificationId: id,
  organizationId: ORG,
  facilityId: "FAC-SIM-001",
  caseId: "CASE-1",
  eventId: "RE-1",
  policyId: "VPOL",
  policyVersion: "sim.1",
  actionIds: ["ACT-1"],
  actionLibraryIds: ["ACT-COOLING-START-BACKUP"],
  postActionWindow: { start: "2026-10-02T10:05:00.000Z", end: "2026-10-02T10:06:00.000Z" },
  requiredAssetIds: ["AST-SIM-FAN-A"],
  requiredSignals: [],
  startedAt: "2026-10-02T10:05:10.000Z",
  correlationId: "CORR-V",
  status: "COMPLETED",
  evaluatedAt: "2026-10-02T10:06:30.000Z",
  assessment: sampleAssessment({
    verificationId: id,
    eventId: "RE-1",
    result,
    requiredCriteria: [
      { criterionId: "VIBRATION", passed: false, role: "REQUIRED", outcome: "FAIL" },
      { criterionId: "CURRENT", passed: true, role: "REQUIRED", outcome: "PASS" },
    ],
  }),
});

describe("follow-up policy", () => {
  it("parses the shipped policy and rejects anything malformed or unknown", () => {
    expect(followPolicy.triggers.VERIFICATION_NOT_IMPROVING).toMatchObject({
      enabled: true,
      recipientRole: "FACILITY_MANAGER",
    });
    const raw = json("notifications/follow-up.v1.json") as Record<string, unknown>;
    const bad = (over: Record<string, unknown>) => () => parseFollowUpPolicy({ ...raw, ...over });
    expect(bad({ schema: "x" })).toThrow();
    expect(bad({ maxFollowUpsPerRiskEvent: 0 })).toThrow();
    expect(
      bad({ triggers: { ...(raw.triggers as object), RECURRENCE: { enabled: false } } }),
    ).toThrow(/unknown trigger/);
    expect(bad({ triggers: {} })).toThrow();
    const t = raw.triggers as Record<string, Record<string, unknown>>;
    expect(
      bad({
        triggers: {
          ...t,
          VERIFICATION_NOT_IMPROVING: { ...t.VERIFICATION_NOT_IMPROVING, recipientRole: "CEO" },
        },
      }),
    ).toThrow();
    expect(
      bad({
        triggers: {
          ...t,
          VERIFICATION_NOT_IMPROVING: { ...t.VERIFICATION_NOT_IMPROVING, cooldownSeconds: -1 },
        },
      }),
    ).toThrow();
    expect(
      bad({ triggers: { ...t, ACTION_OVERDUE: { ...t.ACTION_OVERDUE, overdueAfterSeconds: 1 } } }),
    ).toThrow();
  });
});

describe("follow-up on a completed verification", () => {
  let w: W;
  beforeEach(async () => {
    w = await world();
  });
  const complete = async (result: VerificationResult, id = "VER-1") => {
    await w.verifications.save(attempt(result, id));
    await w.followUps.onVerificationCompleted(ORG, id);
  };
  const followUps = async () =>
    (await w.alerts.listByCase(ORG, "CASE-1")).filter((a) => a.kind === "FOLLOW_UP");

  it("NOT_IMPROVING sends exactly one follow-up that references the prior action and the failed criterion", async () => {
    await complete("NOT_IMPROVING");
    await w.followUps.onVerificationCompleted(ORG, "VER-1"); // redelivery
    const list = await followUps();
    expect(list).toHaveLength(1);
    expect(list[0]?.trigger).toMatchObject({
      type: "VERIFICATION_NOT_IMPROVING",
      referenceId: "VER-1",
    });
    expect(w.sender.requests).toHaveLength(1);
    expect(w.sender.requests[0]?.subject).toMatch(/^\[FOLLOW-UP\]/);
    expect(w.sender.requests[0]?.body).toMatch(/did not improve/);
    expect(w.sender.requests[0]?.body).toMatch(/vibration/i);
    expect(w.sender.requests[0]?.kind).toBe("FOLLOW_UP");
    const audit = (await w.audit.listByCase(ORG, "CASE-1")).filter(
      (e) => e.action === "FOLLOW_UP_REQUESTED",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({
      trigger: "VERIFICATION_NOT_IMPROVING",
      referenceId: "VER-1",
      policyVersion: "1",
    });
  });

  it("VERIFIED produces no follow-up", async () => {
    await complete("VERIFIED");
    expect(await followUps()).toHaveLength(0);
    expect(w.sender.requests).toHaveLength(0);
  });

  it("INCONCLUSIVE and PARTIALLY_VERIFIED follow up under their own triggers", async () => {
    await complete("INCONCLUSIVE", "VER-I");
    w.clock.advance(1_000_000);
    await complete("PARTIALLY_VERIFIED", "VER-P");
    expect((await followUps()).map((a) => a.trigger?.type).sort()).toEqual([
      "VERIFICATION_INCONCLUSIVE",
      "VERIFICATION_PARTIALLY_VERIFIED",
    ]);
  });

  it("a second NOT_IMPROVING inside the cooldown is suppressed and the reason is recorded", async () => {
    await complete("NOT_IMPROVING", "VER-1");
    w.clock.advance(60_000);
    await complete("NOT_IMPROVING", "VER-2");
    expect(await followUps()).toHaveLength(1);
    const suppressed = (await w.audit.listByCase(ORG, "CASE-1")).filter(
      (e) => e.action === "FOLLOW_UP_SUPPRESSED",
    );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.details).toMatchObject({
      trigger: "VERIFICATION_NOT_IMPROVING",
      reason: "COOLDOWN",
    });
    // after the cooldown a new unsuccessful verification follows up again
    w.clock.advance(400_000);
    await complete("NOT_IMPROVING", "VER-3");
    expect(await followUps()).toHaveLength(2);
  });

  it("is capped per risk event", async () => {
    const capped = await world(["SENT"], {
      ...followPolicy,
      maxFollowUpsPerRiskEvent: 2,
      triggers: {
        ...followPolicy.triggers,
        VERIFICATION_NOT_IMPROVING: {
          ...followPolicy.triggers.VERIFICATION_NOT_IMPROVING,
          cooldownSeconds: 0,
        },
      },
    });
    for (const id of ["V1", "V2", "V3"]) {
      await capped.verifications.save(attempt("NOT_IMPROVING", id));
      await capped.followUps.onVerificationCompleted(ORG, id);
      capped.clock.advance(1000);
    }
    expect(
      (await capped.alerts.listByCase(ORG, "CASE-1")).filter((a) => a.kind === "FOLLOW_UP"),
    ).toHaveLength(2);
    expect(
      (await capped.audit.listByCase(ORG, "CASE-1")).filter(
        (e) => e.action === "FOLLOW_UP_SUPPRESSED",
      )[0]?.details?.reason,
    ).toBe("MAX_FOLLOW_UPS");
  });

  it("a disabled trigger sends nothing", async () => {
    const off = await world(["SENT"], {
      ...followPolicy,
      triggers: {
        ...followPolicy.triggers,
        VERIFICATION_NOT_IMPROVING: {
          ...followPolicy.triggers.VERIFICATION_NOT_IMPROVING,
          enabled: false,
        },
      },
    });
    await off.verifications.save(attempt("NOT_IMPROVING"));
    await off.followUps.onVerificationCompleted(ORG, "VER-1");
    expect(off.sender.requests).toHaveLength(0);
  });

  it("ignores an unknown or still-open verification and a closed case", async () => {
    await w.followUps.onVerificationCompleted(ORG, "VER-404");
    await w.verifications.save({ ...attempt("NOT_IMPROVING"), status: "IN_PROGRESS" });
    await w.followUps.onVerificationCompleted(ORG, "VER-1");
    expect(w.sender.requests).toHaveLength(0);
  });

  it("another tenant's verification id resolves to nothing", async () => {
    await w.verifications.save(attempt("NOT_IMPROVING"));
    await w.followUps.onVerificationCompleted("ORG-OTHER", "VER-1");
    expect(w.sender.requests).toHaveLength(0);
  });

  it("a failed first delivery of a follow-up is retried, not duplicated and not lost", async () => {
    const f = await world(["FAILED", "SENT"]);
    await f.verifications.save(attempt("NOT_IMPROVING"));
    await f.followUps.onVerificationCompleted(ORG, "VER-1");
    await f.followUps.onVerificationCompleted(ORG, "VER-1");
    f.clock.advance(61_000);
    await f.alerting.retryDueAlerts();
    const alert = (await f.alerts.listByCase(ORG, "CASE-1")).find((a) => a.kind === "FOLLOW_UP");
    expect(alert?.status).toBe("SENT");
    expect(f.sender.requests).toHaveLength(2); // one failed attempt + one retry, never a duplicate
  });
});

describe("overdue action follow-up", () => {
  it("fires once for an assigned action that was never reported, then respects the cooldown", async () => {
    const w = await world();
    await w.cases.save({ ...w.c, state: "ACTION_REQUIRED" });
    await w.actions.save(ORG, {
      actionId: "ACT-1",
      organizationId: ORG,
      caseId: "CASE-1",
      eventId: "RE-1",
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assignedTo: "USR-OPERATOR-001",
      assignedAt: "2026-10-02T10:01:00.000Z",
      status: "ASSIGNED",
    });
    expect(await w.followUps.tick()).toEqual({ requested: 0, suppressed: 0 });
    w.clock.advance(3_700_000);
    expect(await w.followUps.tick()).toEqual({ requested: 1, suppressed: 0 });
    expect(await w.followUps.tick()).toEqual({ requested: 0, suppressed: 0 }); // same action: duplicate
    expect(
      (await w.alerts.listByCase(ORG, "CASE-1")).filter(
        (a) => a.trigger?.type === "ACTION_OVERDUE",
      ),
    ).toHaveLength(1);
    expect(w.sender.requests[0]?.subject).toMatch(/^\[FOLLOW-UP\]/);
  });

  it("does not fire for a reported action or a case that is not waiting on action", async () => {
    const w = await world();
    await w.actions.save(ORG, {
      actionId: "ACT-1",
      organizationId: ORG,
      caseId: "CASE-1",
      eventId: "RE-1",
      actionLibraryId: "A",
      assignedAt: "2026-10-02T10:01:00.000Z",
      status: "REPORTED_COMPLETE",
      reportedAt: "2026-10-02T10:02:00.000Z",
      reportedBy: "U",
    });
    w.clock.advance(7_200_000);
    expect(await w.followUps.tick()).toEqual({ requested: 0, suppressed: 0 });
  });
});

describe("contacts and content safety", () => {
  it("validates addresses strictly and masks them for display", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.org"])
      expect(isValidEmail(ok)).toBe(true);
    for (const bad of [
      "",
      "a",
      "a@b",
      "a b@c.co",
      "a@b.co,c@d.co",
      "a@b.co;c@d.co",
      "<a@b.co>",
      "a@b.co\r\nBcc: x@y.z",
      "a@@b.co",
      "x".repeat(300) + "@b.co",
      "a@-b.co",
      null,
      5,
    ]) {
      expect(isValidEmail(bad as string), String(bad)).toBe(false);
    }
    expect(maskEmail("charan@gmail.com")).toBe("c***n@gmail.com");
    expect(maskEmail("ab@x.io")).toBe("a***@x.io");
    expect(maskEmail("nonsense")).toBe("***");
  });

  it("stores contacts per organization and refuses an invalid address", async () => {
    const dir = new StoreContactDirectory(new InMemoryTenantDocumentStore());
    const rec = {
      actorId: "USR-1",
      organizationId: "ORG-A",
      email: "a@b.co",
      enabled: true,
      categories: ["INITIAL" as const],
      updatedAt: "t",
      updatedBy: "u",
    };
    await dir.put(rec);
    expect(await dir.get("ORG-A", "USR-1")).toEqual(rec);
    expect(await dir.get("ORG-B", "USR-1")).toBeUndefined();
    await expect(dir.put({ ...rec, email: "not an email" })).rejects.toThrow();
  });

  it("an email body carries no secret, signature, address or insurer information", async () => {
    const w = await world();
    const a = await initial(w);
    const text = `${w.sender.requests[0]?.subject}\n${w.sender.requests[0]?.body}`;
    expect(text).not.toMatch(/@|hmac|signature|secret|password|insurer|raw/i);
    expect(a.alertId).toBeTruthy();
    const composed = composeAlert({
      caseRecord: w.c,
      kind: "FOLLOW_UP",
      reasonCodes: [],
      casePath: "/p",
      trigger: { type: "VERIFICATION_NOT_IMPROVING", referenceId: "V", why: "because" },
      extras: {
        facilityName: "Northgate",
        caseUrl: "https://app.example/operations/cases/CASE-1",
        statusLabel: "Not improving",
      },
    });
    expect(composed.body).toMatch(/\(sign-in required\)/);
    expect(composed.body).toMatch(/Why you are receiving this: because/);
    expect(composed.subject).toBe(`[FOLLOW-UP] [HIGH] ${w.c.title} · Northgate`);
  });
});
