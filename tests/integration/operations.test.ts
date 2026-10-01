import { afterEach, describe, expect, it } from "vitest";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { ScriptedNotificationSender } from "@symbiosis/notifications/testing";
import type { NotificationSender } from "@symbiosis/notifications";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime } from "../../scripts/local-runtime";

const ORG = "ORG-SIM-001";
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const ADMIN = "USR-ORG-ADMIN-001";
const AUDITOR = "USR-AUDITOR-001";
const OTHER = "USR-OTHER-ORG-MGR-001";

/** Parsed JSON bodies are inspected loosely in tests (JSON.parse returns `any`). */
type Json = ReturnType<typeof JSON.parse>;

type World = {
  runtime: LocalRuntime;
  clock: ManualClock;
  client: SimulatorClient;
  emails: string[];
  run(scenario: ScenarioName, count: number): Promise<void>;
  api(
    method: string,
    path: string,
    actor: string | undefined,
    body?: unknown,
  ): Promise<{ status: number; body: Json }>;
  html(path: string): Promise<{ status: number; text: string }>;
  detect(): Promise<string>;
  types(): string[];
};

const open: LocalRuntime[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

async function makeWorld(senderFor?: (clock: ManualClock) => NotificationSender): Promise<World> {
  const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  const emails: string[] = [];
  const runtime = await createLocalRuntime({
    clock,
    ids: new SequentialIdGenerator(),
    consoleSink: (line) => emails.push(line),
    ...(senderFor !== undefined && { notificationSender: senderFor(clock) }),
  });
  open.push(runtime);
  const client = new SimulatorClient({
    baseUrl: runtime.server.baseUrl,
    deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
    keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
    key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
    clock,
    initialSeq: 1,
  });
  await client.sendHeartbeat("HEALTHY");

  const world: World = {
    runtime,
    clock,
    client,
    emails,
    async run(scenario, count) {
      for (let i = 0; i < count; i++) {
        const res = await client.sendTelemetry(scenarioReadings(scenario, i));
        expect(res.status).toBe(202);
        clock.advance(5000);
      }
    },
    async api(method, path, actor, body) {
      const res = await fetch(`${runtime.server.baseUrl}${path}`, {
        method,
        headers: {
          ...(actor !== undefined && { "X-Demo-Actor-Id": actor }),
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && {
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      });
      const text = await res.text();
      let parsed: Json = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      return { status: res.status, body: parsed };
    },
    async html(path) {
      const res = await fetch(`${runtime.server.baseUrl}${path}`);
      return { status: res.status, text: await res.text() };
    },
    /** Learn the baseline, then send persistent compound deterioration; returns the case ID. */
    async detect() {
      await world.run("normal", 25);
      await world.run("compound-outdoor-heat", 3);
      const [c] = await runtime.cases.list(ORG);
      expect(c).toBeDefined();
      return c!.caseId;
    },
    types: () => runtime.bus.history().map((e) => e.event_type as string),
  };
  return world;
}

describe("full operations workflow over HTTP", () => {
  it("detected -> alert -> ALERTED -> acknowledge -> assign -> action ack -> report -> VERIFICATION PENDING", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();

    // alert requested, notification sent via ConsoleEmail, event ALERTED
    const alertTypes = w
      .types()
      .filter((t) => /^(risk\.alert_requested|notification\.|risk\.alerted)/.test(t));
    expect(alertTypes).toEqual([
      "risk.alert_requested.v1",
      "notification.requested.v1",
      "notification.sent.v1",
      "risk.alerted.v1",
    ]);
    expect(w.emails).toHaveLength(1);
    expect(w.emails[0]).toContain(`To: ${MGR} (FACILITY_MANAGER)`);
    expect(w.emails[0]).toContain(caseId);
    expect(w.emails[0]).toContain("MODERATE");
    expect(w.emails[0]).toContain("nothing was emailed");
    expect(w.emails[0]).not.toMatch(/token|secret/i);

    const list = await w.api("GET", "/api/v1/cases", MGR);
    expect(list.status).toBe(200);
    expect(list.body.cases).toHaveLength(1);
    expect(list.body.cases[0]).toMatchObject({ caseId, state: "OPEN", riskEventState: "ALERTED" });

    let view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.accountability.alert).toMatchObject({ status: "SENT", recipient: MGR });
    expect(view.body.didItWork.label).toBe("NO ACTION REPORTED YET");

    // acknowledgement
    const ack = await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, { note: "seen" });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ caseState: "OPEN", riskEventState: "ACKNOWLEDGED" });
    const dup = await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    expect(dup.status).toBe(409);

    // assignment of an approved action
    const assign = await w.api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    expect(assign.status).toBe(201);
    expect(assign.body).toMatchObject({
      caseState: "ACTION_REQUIRED",
      riskEventState: "ACKNOWLEDGED",
    });
    const actionId = assign.body.actionId as string;

    // the assignee acknowledges responsibility
    const actAck = await w.api(
      "POST",
      `/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`,
      OPERATOR,
      {},
    );
    expect(actAck.status).toBe(200);
    expect(actAck.body).toMatchObject({ caseState: "ACTION_REQUIRED" });

    // report the action
    const report = await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
      notes: "Found loose mount <script>alert(1)</script>; tightened.",
      attachments: ["ATT-LOCAL-1"],
    });
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      caseState: "ACTION_REPORTED",
      riskEventState: "ACTION_REPORTED",
      actionId,
    });

    view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.state).toBe("ACTION_REPORTED");
    expect(view.body.riskEventState).toBe("ACTION_REPORTED");
    expect(view.body.didItWork).toMatchObject({
      status: "VERIFICATION_PENDING",
      label: "VERIFICATION PENDING",
    });
    expect(view.body.whatWasDone.actions[0]).toMatchObject({
      status: "REPORTED_COMPLETE",
      reportedBy: OPERATOR,
    });
    expect(view.body.accountability.acknowledgement).toMatchObject({ acknowledged: true, by: MGR });
    expect(view.body.reasonCodes).toContain("OUTDOOR_HEAT_CONTEXT");
    expect(JSON.stringify(view.body)).not.toMatch(/VERIFIED/i);

    // the system stops here: no verification of any kind
    expect(w.types().filter((t) => t.startsWith("verification"))).toEqual([]);
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("ACTION_REPORTED");
    expect(c?.latestVerificationId).toBeUndefined();

    // event order of the workflow (ignoring detection chatter)
    const flow = w
      .types()
      .filter((t) =>
        /^(risk\.alert_requested|notification\.|risk\.alerted|risk\.acknowledged|action\.)/.test(t),
      );
    expect(flow).toEqual([
      "risk.alert_requested.v1",
      "notification.requested.v1",
      "notification.sent.v1",
      "risk.alerted.v1",
      "risk.acknowledged.v1",
      "action.assigned.v1",
      "action.acknowledged.v1",
      "action.reported.v1",
    ]);
    const changes = w.runtime.bus
      .history()
      .map((e) => (e.event_type === "case.updated.v1" ? e.payload.change : undefined))
      .filter((x) => x !== undefined && x !== "DETECTION_CONTINUED");
    expect(changes).toEqual(["ACTION_REQUIRED", "ACTION_REPORTED"]);

    // audit trail of every material action
    const audit = (await w.runtime.audit.listByCase(ORG, caseId)).map((e) => e.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        "CASE_CREATED",
        "ALERT_REQUESTED",
        "ALERT_SENT",
        "RISK_ALERTED",
        "RISK_ACKNOWLEDGED",
        "ACTION_ASSIGNED",
        "ACTION_ACKNOWLEDGED",
        "ACTION_REPORTED",
      ]),
    );
  });

  it("the minimal case page shows VERIFICATION PENDING, never VERIFIED, and escapes content", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
      actionLibraryId: "ACT-COOLING-START-BACKUP",
      notes: "<script>alert(1)</script> started backup",
    });

    const list = await w.html(`/ui/cases?actor=${MGR}`);
    expect(list.status).toBe(200);
    expect(list.text).toContain(caseId);
    expect(list.text).toContain("VERIFICATION PENDING");

    const page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.status).toBe(200);
    for (const heading of [
      "What happened",
      "Accountability",
      "What to do",
      "What was done",
      "Did it work?",
      "Evidence",
      "Sharing",
    ]) {
      expect(page.text).toContain(heading);
    }
    expect(page.text).toContain("VERIFICATION PENDING");
    expect(page.text).toContain("ACTION_REPORTED");
    expect(page.text).toContain("NOT SHARED");
    expect(page.text).not.toMatch(/VERIFIED/i);
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).toContain("&lt;script&gt;");
    expect(page.text).toContain("Not the final UI");
    expect(page.text).not.toMatch(/<script/i);
  });

  it("before any report the page does not say verification is pending", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    const page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.text).not.toContain("VERIFICATION PENDING");
    expect(page.text).toContain("NO ACTION REPORTED YET");
    expect(page.text).toContain("ALERTED");
  });

  it("continued deterioration while ACTION_REQUIRED keeps the state, adds no case, and is recorded", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    await w.api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    const before = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body.detectionCount;
    await w.run("compound-outdoor-heat", 3);
    const view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.state).toBe("ACTION_REQUIRED");
    expect(view.body.riskEventState).toBe("ACKNOWLEDGED");
    expect(view.body.detectionCount).toBe(before + 3);
    expect(await w.runtime.cases.list(ORG)).toHaveLength(1);
    expect(w.types().filter((t) => t.startsWith("verification"))).toEqual([]);
    expect(w.types().filter((t) => t === "case.created.v1")).toHaveLength(1);
  });

  it("continued deterioration while ACTION_REPORTED waits for verification: no reset, no duplicate, no verdict", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
    });
    const before = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body.detectionCount;
    await w.run("compound-outdoor-heat", 4);
    const view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.state).toBe("ACTION_REPORTED");
    expect(view.body.riskEventState).toBe("ACTION_REPORTED");
    expect(view.body.didItWork.label).toBe("VERIFICATION PENDING");
    expect(view.body.detectionCount).toBe(before + 4);
    expect(await w.runtime.cases.list(ORG)).toHaveLength(1);
    const detections = (await w.runtime.audit.listByCase(ORG, caseId)).filter(
      (e) => e.action === "DETECTION_RECORDED",
    );
    expect(detections.length).toBeGreaterThanOrEqual(4);
    expect(detections.at(-1)?.afterState).toBe("ACTION_REPORTED");
    // never NOT_IMPROVING / INCONCLUSIVE etc.
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(["ACTION_REPORTED"]).toContain(c?.state);
    expect(w.types().filter((t) => /^(verification|evidence|consent|recurrence)/.test(t))).toEqual(
      [],
    );
  });

  it("dismissal is permissioned, needs a reason, and closes the case administratively", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    expect(
      (await w.api("POST", `/api/v1/cases/${caseId}/dismiss`, OPERATOR, { reason: "calibration" }))
        .status,
    ).toBe(403);
    expect((await w.api("POST", `/api/v1/cases/${caseId}/dismiss`, MGR, {})).status).toBe(400);
    const ok = await w.api("POST", `/api/v1/cases/${caseId}/dismiss`, MGR, {
      reason: "Sensor calibration in progress",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ caseState: "CLOSED", riskEventState: "DISMISSED_FALSE_ALARM" });
  });
});

describe("HTTP identity, tenancy and permissions (development identity)", () => {
  it("rejects missing or unknown actors", async () => {
    const w = await makeWorld();
    expect((await w.api("GET", "/api/v1/cases", undefined)).status).toBe(401);
    expect((await w.api("GET", "/api/v1/cases", "USR-NOBODY")).status).toBe(401);
    expect((await w.api("GET", "/api/v1/cases", "x".repeat(300))).status).toBe(401);
    const ui = await w.html("/ui/cases");
    expect(ui.status).toBe(401);
    expect(ui.text).toContain("development actor");
  });

  it("another organization cannot read or act on a case, even knowing its ID or sending organizationId", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    expect((await w.api("GET", `/api/v1/cases/${caseId}`, OTHER)).status).toBe(404);
    expect(
      (await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, OTHER, { organizationId: ORG }))
        .status,
    ).toBe(404);
    expect(
      (
        await w.api("POST", `/api/v1/cases/${caseId}/actions`, OTHER, {
          organizationId: ORG,
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
        })
      ).status,
    ).toBe(404);
    expect(
      (await w.api("POST", `/api/v1/cases/${caseId}/dismiss`, OTHER, { reason: "x" })).status,
    ).toBe(404);
    const list = await w.api("GET", "/api/v1/cases", OTHER);
    expect(list.body.cases).toEqual([]);
    expect((await w.html(`/ui/cases/${caseId}?actor=${OTHER}`)).status).toBe(404);
    // the owner organization's state is untouched
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ALERTED");
    expect(await w.runtime.actions.listByCase(ORG, caseId)).toEqual([]);
  });

  it("enforces roles: auditor reads only, operator cannot assign, manager cannot run the tick", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    expect((await w.api("GET", `/api/v1/cases/${caseId}`, AUDITOR)).status).toBe(200);
    expect((await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, AUDITOR, {})).status).toBe(
      403,
    );
    expect(
      (
        await w.api("POST", `/api/v1/cases/${caseId}/assignments`, OPERATOR, {
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
          assigneeId: OPERATOR,
        })
      ).status,
    ).toBe(403);
    expect((await w.api("POST", "/api/v1/ops/tick", MGR, {})).status).toBe(403);
    expect((await w.api("POST", "/api/v1/ops/tick", ADMIN, {})).status).toBe(200);
  });

  it("validates requests: bad JSON, unapproved actions, bad IDs and unknown routes", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    expect(
      (await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, "{not json")).status,
    ).toBe(400);
    expect((await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, "[1,2]")).status).toBe(
      400,
    );
    const bad = await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
      actionLibraryId: "ACT-SHUTDOWN-EVERYTHING",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
    expect(
      (
        await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
          attachments: [{ data: "AAAA" }],
        })
      ).status,
    ).toBe(400);
    expect((await w.api("GET", "/api/v1/cases/..%2F..%2Fetc", MGR)).status).toBe(404);
    expect((await w.api("GET", "/api/v1/nonsense", MGR)).status).toBe(404);
    expect((await w.api("DELETE", `/api/v1/cases/${caseId}`, MGR)).status).toBe(405);
    expect((await w.api("GET", `/api/v1/cases/${caseId}x`, MGR)).status).toBe(404);
  });

  it("/me reports the development identity and permissions, never credentials", async () => {
    const w = await makeWorld();
    const me = await w.api("GET", "/api/v1/me", OPERATOR);
    expect(me.body).toMatchObject({
      actorId: OPERATOR,
      organizationId: ORG,
      identity: "DEVELOPMENT_ONLY",
    });
    expect(JSON.stringify(me.body)).not.toMatch(/password|token|secret/i);
  });

  it("the signed edge endpoints still work beside the human API", async () => {
    const w = await makeWorld();
    expect((await w.client.sendTelemetry()).status).toBe(202);
    const unsigned = await fetch(`${w.runtime.server.baseUrl}/edge/v1/telemetry`, {
      method: "POST",
      body: "{}",
    });
    expect(unsigned.status).toBe(400);
  });
});

describe("escalation in simulated time", () => {
  it("escalates an unacknowledged alert after the configured deadline and notifies the escalation role", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    const before = w.emails.length;
    // the deadline runs from when the alert was SENT (detect() leaves the clock 5 s later)
    const [initial] = await w.runtime.alerts.listByCase(ORG, caseId);
    const sentAtMs = Date.parse(initial?.sentAt as string);

    w.clock.set(sentAtMs + 899_000);
    const early = await w.api("POST", "/api/v1/ops/tick", ADMIN, {});
    expect(early.body.escalated).toEqual([]);
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ALERTED");

    w.clock.set(sentAtMs + 900_000);
    const tick = await w.api("POST", "/api/v1/ops/tick", ADMIN, {});
    expect(tick.body.escalated).toHaveLength(1);
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ESCALATED");

    const escalated = w.runtime.bus.history().filter((e) => e.event_type === "risk.escalated.v1");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.event_type === "risk.escalated.v1" && escalated[0].payload).toMatchObject({
      reason: "ACKNOWLEDGEMENT_OVERDUE",
      acknowledgementDeadlineSeconds: 900,
    });
    expect(w.emails.length).toBe(before + 1);
    expect(w.emails.at(-1)).toContain(`To: ${ADMIN} (ORG_ADMIN)`);
    expect(w.emails.at(-1)).toContain("[ESCALATION]");

    // original alert preserved alongside the escalation alert
    const alerts = await w.runtime.alerts.listByCase(ORG, caseId);
    expect(alerts.map((a) => a.kind).sort()).toEqual(["ESCALATION", "INITIAL"]);
    expect(alerts.find((a) => a.kind === "INITIAL")?.status).toBe("SENT");

    // escalation is operational urgency only
    expect((await w.runtime.cases.get(ORG, caseId))?.severity).toBe("MODERATE");
    const view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.accountability.escalation.escalated).toBe(true);

    // a second tick does nothing; the human can still acknowledge and continue
    expect((await w.api("POST", "/api/v1/ops/tick", ADMIN, {})).body.escalated).toEqual([]);
    const ack = await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    expect(ack.body.riskEventState).toBe("ACKNOWLEDGED");
  });

  it("an event acknowledged before the deadline is never escalated", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    w.clock.advance(300_000);
    await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    w.clock.advance(10 * 3600_000);
    const tick = await w.api("POST", "/api/v1/ops/tick", ADMIN, {});
    expect(tick.body.escalated).toEqual([]);
    expect(w.types()).not.toContain("risk.escalated.v1");
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ACKNOWLEDGED");
  });
});

describe("notification failure and retry", () => {
  it("a failed alert never claims delivery; a retry succeeds without duplicating case or action state", async () => {
    let sender!: ScriptedNotificationSender;
    const w = await makeWorld(
      (clock) => (sender = new ScriptedNotificationSender(clock, ["FAILED", "SENT"])),
    );
    const caseId = await w.detect();

    expect(w.types()).toContain("notification.failed.v1");
    expect(w.types()).not.toContain("risk.alerted.v1");
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("DETECTED");
    let view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.accountability.alert).toMatchObject({
      status: "FAILED",
      deliveryFailed: true,
      attempts: 1,
    });
    const page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.text).toContain("delivery failed");

    // cannot be acknowledged as if it had been alerted
    expect((await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {})).status).toBe(409);

    // retry is not due yet, then succeeds
    expect((await w.api("POST", "/api/v1/ops/tick", ADMIN, {})).body.retried).toBe(0);
    w.clock.advance(60_000);
    expect((await w.api("POST", "/api/v1/ops/tick", ADMIN, {})).body.retried).toBe(1);
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ALERTED");
    view = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(view.body.accountability.alert).toMatchObject({
      status: "SENT",
      deliveryFailed: false,
      attempts: 2,
    });

    // one case, one alert, one alerted event; the workflow continues normally
    expect(await w.runtime.cases.list(ORG)).toHaveLength(1);
    expect(
      (await w.runtime.alerts.listByCase(ORG, caseId)).filter((a) => a.kind === "INITIAL"),
    ).toHaveLength(1);
    expect(w.types().filter((t) => t === "risk.alerted.v1")).toHaveLength(1);
    expect(sender.requests.filter((r) => r.subject.includes("[ALERT]"))).toHaveLength(2);
    expect((await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {})).status).toBe(200);
    expect(await w.runtime.actions.listByCase(ORG, caseId)).toEqual([]);
  });

  it("when every attempt fails, the tick escalates the still-undelivered risk so a human is reached", async () => {
    const w = await makeWorld((clock) => new ScriptedNotificationSender(clock, ["FAILED"]));
    const caseId = await w.detect();
    for (let i = 0; i < 2; i++) {
      w.clock.advance(60_000);
      await w.api("POST", "/api/v1/ops/tick", ADMIN, {});
    }
    const [alert] = (await w.runtime.alerts.listByCase(ORG, caseId)).filter(
      (a) => a.kind === "INITIAL",
    );
    expect(alert).toMatchObject({ status: "FAILED", exhausted: true });
    expect(alert?.attempts).toHaveLength(3);
    const escalated = w.runtime.bus.history().filter((e) => e.event_type === "risk.escalated.v1");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.event_type === "risk.escalated.v1" && escalated[0].payload.reason).toBe(
      "ALERT_DELIVERY_EXHAUSTED",
    );
    expect((await w.runtime.riskEvents.listByCase(ORG, caseId))[0]?.state).toBe("ESCALATED");
    const ack = await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
    expect(ack.body.riskEventState).toBe("ACKNOWLEDGED");
  });
});
