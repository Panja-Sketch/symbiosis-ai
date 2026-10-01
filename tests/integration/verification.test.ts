import { afterEach, describe, expect, it } from "vitest";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import type { Readings } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { observationIdFor } from "@symbiosis/normalization";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime } from "../../scripts/local-runtime";

const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const AUDITOR = "USR-AUDITOR-001";
const OTHER = "USR-OTHER-ORG-MGR-001";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";
const BACKUP = "ACT-COOLING-START-BACKUP";

type Json = ReturnType<typeof JSON.parse>;

const open: LocalRuntime[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

async function makeWorld() {
  const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  const runtime = await createLocalRuntime({
    clock,
    ids: new SequentialIdGenerator(),
    consoleSink: () => {},
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

  async function api(method: string, path: string, actor: string, body?: unknown) {
    const res = await fetch(`${runtime.server.baseUrl}${path}`, {
      method,
      headers: {
        "X-Demo-Actor-Id": actor,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  const w = {
    runtime,
    clock,
    client,
    api,
    types: () => runtime.bus.history().map((e) => e.event_type as string),
    /** Sends `count` samples 5 s apart (simulated time); `tweak` can alter or drop readings. */
    async send(
      scenario: ScenarioName,
      count: number,
      tweak?: (r: Readings, i: number) => Readings,
    ) {
      for (let i = 0; i < count; i++) {
        const base = scenarioReadings(scenario, i);
        const res = await client.sendTelemetry(tweak ? tweak(base, i) : base);
        expect(res.status).toBe(202);
        clock.advance(5000);
      }
    },
    async detect() {
      await w.send("normal", 25);
      await w.send("compound-outdoor-heat", 3);
      const [c] = await runtime.cases.list(ORG);
      expect(c).toBeDefined();
      return (c as { caseId: string }).caseId;
    },
    /** detected -> acknowledged -> assigned -> reported. Leaves the clock at the report time. */
    async reportAction(caseId: string, library = INSPECT, fresh = false) {
      if (!fresh) {
        expect((await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {})).status).toBe(
          200,
        );
      }
      const assign = await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
        actionLibraryId: library,
        assigneeId: OPERATOR,
      });
      expect(assign.status).toBe(201);
      const actionId = assign.body.actionId as string;
      const report = await api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
        actionLibraryId: library,
        actionId,
        notes: "done",
      });
      expect(report.status).toBe(200);
      expect(report.body.caseState).toBe("ACTION_REPORTED");
      return actionId;
    },
    view: async (caseId: string) => (await api("GET", `/api/v1/cases/${caseId}`, MGR)).body,
    verifications: async (caseId: string) => runtime.verifications.listByCase(ORG, caseId),
    async latest(caseId: string) {
      const all = await runtime.verifications.listByCase(ORG, caseId);
      return all.at(-1);
    },
  };
  return w;
}
type World = Awaited<ReturnType<typeof makeWorld>>;

async function expectEvidenceReal(w: World, verificationId: string) {
  const resolved = await w.runtime.resolveEvidence(verificationId, ORG);
  expect(resolved.length).toBeGreaterThan(0);
  expect(resolved.filter((r) => !r.exists)).toEqual([]);
}

describe("V1 successful improvement (end to end)", () => {
  it("action report -> VERIFICATION PENDING -> trusted post-action data -> VERIFIED -> VERIFIED_IMPROVED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);

    // the report itself verifies nothing, even after a scheduler pass
    let v = await w.view(caseId);
    expect(v.state).toBe("ACTION_REPORTED");
    expect(v.didItWork.label).toBe("VERIFICATION PENDING");
    expect(w.types().some((t) => t.startsWith("verification."))).toBe(false);

    const t1 = await w.runtime.tick();
    expect(t1.verification.started).toHaveLength(1);
    expect(t1.verification.completed).toHaveLength(0);
    v = await w.view(caseId);
    expect(v.state).toBe("VERIFYING");
    expect(v.riskEventState).toBe("VERIFYING");
    expect(v.didItWork.label).toBe("VERIFICATION PENDING");
    expect(v.verification.status).toBe("IN_PROGRESS");

    await w.send("normal", 25); // the whole post-action window, trusted and healthy
    const t2 = await w.runtime.tick();
    expect(t2.verification.completed).toEqual([
      expect.objectContaining({ caseId, result: "VERIFIED" }),
    ]);

    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("VERIFIED_IMPROVED");
    const attempt = await w.latest(caseId);
    expect(c?.latestVerificationId).toBe(attempt?.verificationId);
    expect(attempt).toMatchObject({
      status: "COMPLETED",
      policyId: "VPOL-COOLING-ELECTRICAL",
      policyVersion: "1",
    });
    expect(attempt?.assessment).toMatchObject({
      result: "VERIFIED",
      dataCompleteness: 1,
      authIntegrityStatus: "VERIFIED",
    });
    const event = await w.runtime.riskEvents.get(ORG, attempt?.eventId ?? "");
    expect(event).toMatchObject({
      state: "VERIFIED",
      latestVerificationId: attempt?.verificationId,
    });

    // events: started then completed, correlated and caused
    const hist = w.runtime.bus.history();
    const started = hist.find((e) => e.event_type === "verification.started.v1");
    const completed = hist.find((e) => e.event_type === "verification.completed.v1");
    expect(started && completed).toBeTruthy();
    expect(completed?.causation_id).toBe(started?.event_id);
    expect(completed?.correlation_id).toBe(started?.correlation_id);
    const reported = hist.find((e) => e.event_type === "action.reported.v1");
    expect(started?.causation_id).toBe(reported?.event_id);
    expect(started?.correlation_id).toBe(reported?.correlation_id);
    expect(completed?.payload).toMatchObject({
      result: "VERIFIED",
      policyId: "VPOL-COOLING-ELECTRICAL",
      policyVersion: "1",
      caseId,
      completeness: 1,
    });
    expect(w.types().some((t) => t.startsWith("evidence."))).toBe(false);

    await expectEvidenceReal(w, attempt?.verificationId ?? "");

    // API + UI
    v = await w.view(caseId);
    expect(v.didItWork).toMatchObject({ status: "VERIFIED_IMPROVED", label: "VERIFIED IMPROVED" });
    expect(v.verification.criteria.map((x: Json) => x.criterionId).sort()).toEqual(
      ["CURRENT", "DATA_QUALITY", "DEVICE_INTEGRITY", "VIBRATION", "ZONE_TEMPERATURE_SLOPE"].sort(),
    );
    expect(v.verification.evidenceReferenceCount).toBeGreaterThan(40);
    expect(v.stayingFixed).toMatchObject({ watch: "WATCHING", recurrenceCount: 0 });
    expect(v.intervention).toMatchObject({ level: "REMOTE_MONITORING" });
    const page = await (
      await fetch(`${w.runtime.server.baseUrl}/ui/cases/${caseId}?actor=${MGR}`)
    ).text();
    expect(page).toContain("VERIFIED IMPROVED");
    expect(page).toContain("VPOL-COOLING-ELECTRICAL");
    expect(page).toContain("Is it staying fixed?");
    const api = await w.api("GET", `/api/v1/verifications/${attempt?.verificationId}`, MGR);
    expect(api.status).toBe(200);
    expect(api.body.assessment.result).toBe("VERIFIED");
    expect(w.runtime.bus.deadLetters()).toEqual([]);
  });

  it("does not conclude before the post-action window ends", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick(); // starts
    await w.send("normal", 10); // 50 s of a 120 s window
    const t = await w.runtime.tick();
    expect(t.verification.completed).toEqual([]);
    expect((await w.view(caseId)).didItWork.label).toBe("VERIFICATION PENDING");
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFYING");
    await w.send("normal", 15);
    expect((await w.runtime.tick()).verification.completed).toHaveLength(1);
  });

  it("is deterministic: two identical runs produce identical assessments", async () => {
    const run = async () => {
      const w = await makeWorld();
      const caseId = await w.detect();
      await w.reportAction(caseId);
      await w.runtime.tick();
      await w.send("normal", 25);
      await w.runtime.tick();
      return (await w.latest(caseId))?.assessment;
    };
    expect(await run()).toEqual(await run());
  });
});

describe("an action report is never proof (regression)", () => {
  it("action report + no post-action telemetry never yields VERIFIED (INCONCLUSIVE)", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    w.clock.advance(200_000); // window over, nothing was sent
    const t = await w.runtime.tick();
    expect(t.verification.completed).toEqual([expect.objectContaining({ result: "INCONCLUSIVE" })]);
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("INCONCLUSIVE");
    const a = (await w.latest(caseId))?.assessment;
    expect(a?.dataCompleteness).toBe(0);
    expect(a?.reasonCodes).toContain("VIBRATION:REQUIRED_SIGNAL_MISSING");
    expect((await w.view(caseId)).didItWork.label).toBe("INCONCLUSIVE");
  });

  it("insufficient samples never yields VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 4);
    w.clock.advance(200_000);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
  });

  it("stale required telemetry never yields VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    // 25 in-window samples that only reach the platform 400 s late (older than the stale limit)
    const reportedAt = w.clock.nowMs();
    const batch = Array.from({ length: 25 }, (_, i) => ({
      observed_at: new Date(reportedAt + i * 5000).toISOString(),
      readings: scenarioReadings("normal", i),
    }));
    w.clock.advance(400_000);
    const res = await w.client.send(
      w.client.buildTelemetryRequestFromPayload({
        device_id: SYNTHETIC_DEV_DEVICE.deviceId,
        firmware_version: "sim",
        source: "SIMULATOR",
        batch,
      }),
    );
    expect(res.status).toBe(202);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
    const reasons = (await w.latest(caseId))?.assessment?.reasonCodes ?? [];
    expect(reasons.some((r) => r.endsWith("STALE_REQUIRED_TELEMETRY"))).toBe(true);
  });

  it("unauthenticated evidence never yields VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    const start = w.clock.nowMs();
    for (let i = 0; i < 25; i++) {
      const at = new Date(start + i * 5000).toISOString();
      for (const [signal, value] of [
        ["vibration_rms", 0.18],
        ["current", 0.312],
        ["load_percent", 100],
      ] as const) {
        await w.runtime.observations.insertIfAbsent({
          observationId: observationIdFor(SYNTHETIC_DEV_DEVICE.deviceId, signal, at),
          organizationId: ORG,
          facilityId: SYNTHETIC_DEV_DEVICE.facilityId,
          assetId: "AST-SIM-FAN-A",
          deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
          signal,
          value,
          unit: "x",
          observedAt: at,
          receivedAt: at,
          sourceType: "SIMULATOR",
          sourceAdapter: "test",
          quality: {
            confidence: 0,
            stale: false,
            outOfRange: false,
            deviceHealthy: true,
            authVerified: false,
          },
        });
      }
    }
    w.clock.advance(130_000);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
    expect((await w.latest(caseId))?.assessment?.authIntegrityStatus).toBe(
      "UNAUTHENTICATED_EVIDENCE_PRESENT",
    );
  });

  it("an unhealthy required device never yields VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.client.sendHeartbeat("FAULT");
    await w.send("normal", 25);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
    expect((await w.latest(caseId))?.assessment?.deviceHealthStatus).toBe("NOT_HEALTHY");
  });

  it("a verification processing failure becomes INCONCLUSIVE, never VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    w.runtime.observations.listForWindow = async () => {
      throw new Error("repository unavailable");
    };
    const t = await w.runtime.tick();
    expect(t.verification.failures.map((f) => f.code)).toContain("PROCESSING_FAILURE");
    const a = (await w.latest(caseId))?.assessment;
    expect(a?.result).toBe("INCONCLUSIVE");
    expect(a?.reasonCodes).toContain("VERIFICATION_PROCESSING_FAILURE");
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
  });

  it("the API offers no way to set a verification result", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    for (const path of [
      `/api/v1/cases/${caseId}/verify`,
      `/api/v1/cases/${caseId}/verification`,
      `/api/v1/verifications`,
    ]) {
      const r = await w.api("POST", path, MGR, { result: "VERIFIED" });
      expect([404, 405]).toContain(r.status);
    }
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("ACTION_REPORTED");
  });
});

describe("V2 / V3 / V4 outcomes and verification history", () => {
  it("V2: action performed but the condition remains bad => NOT_IMPROVING (and a follow-up cycle is possible)", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick();
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("NOT_IMPROVING");
    const v = await w.view(caseId);
    expect(v.didItWork.label).toBe("NOT IMPROVING");
    expect(v.verification.reasonCodes).toContain("VIBRATION:STILL_MATERIALLY_ABNORMAL");
    expect(v.intervention.level).toBe("REMOTE_REVIEW");
    // not closed: a second approved action can be assigned and reported, then verified
    await w.reportAction(caseId, INSPECT, true);
    expect((await w.view(caseId)).state).toBe("ACTION_REPORTED");
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
    const history = await w.verifications(caseId);
    expect(history.map((h) => h.assessment?.result)).toEqual(["NOT_IMPROVING", "VERIFIED"]);
    expect(new Set(history.map((h) => h.verificationId)).size).toBe(2);
    expect(history[0]?.status).toBe("COMPLETED");
  });

  it("history keeps INCONCLUSIVE, then NOT_IMPROVING, then VERIFIED; repeated failures raise the intervention level", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    w.clock.advance(200_000);
    await w.runtime.tick(); // INCONCLUSIVE
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
    expect((await w.view(caseId)).intervention.level).toBe("REMOTE_REVIEW");

    await w.reportAction(caseId, INSPECT, true);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick(); // NOT_IMPROVING
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("NOT_IMPROVING");
    const mid = await w.view(caseId);
    expect(mid.intervention.level).toBe("RISK_ENGINEER_REVIEW");
    expect(mid.intervention.reasonCodes).toContain("TWO_CONSECUTIVE_UNSUCCESSFUL_VERIFICATIONS");

    await w.reportAction(caseId, INSPECT, true);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick(); // VERIFIED
    const history = await w.verifications(caseId);
    expect(history.map((h) => h.assessment?.result)).toEqual([
      "INCONCLUSIVE",
      "NOT_IMPROVING",
      "VERIFIED",
    ]);
    const all = await w.runtime.interventions.listByCase(ORG, caseId);
    expect(all.filter((r) => r.status === "SUPERSEDED").length).toBe(all.length - 1);
    expect(all.at(-1)).toMatchObject({ status: "ACTIVE", level: "REMOTE_MONITORING" });
    for (const a of history) await expectEvidenceReal(w, a.verificationId);
  });

  it("V4: partial improvement => PARTIALLY_VERIFIED, still available for human action", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("partial-improvement", 25);
    await w.runtime.tick();
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("PARTIALLY_VERIFIED");
    expect((await w.view(caseId)).didItWork.label).toBe("PARTIALLY VERIFIED");
    await w.reportAction(caseId, INSPECT, true); // not silently closed
    expect((await w.view(caseId)).state).toBe("ACTION_REPORTED");
  });
});

describe("backup capacity is observed, never believed", () => {
  it("start-backup reported + backup observed running => VERIFIED", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.runtime.tick();
    await w.send("backup-running", 25);
    await w.runtime.tick();
    const a = (await w.latest(caseId))?.assessment;
    expect(a?.requiredCriteria.map((c) => c.criterionId)).toContain("BACKUP_CAPACITY");
    expect(a?.result).toBe("VERIFIED");
  });

  it("start-backup reported but never observed running => NOT_IMPROVING", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.runtime.tick();
    await w.send("normal", 25); // chiller_b_running stays false
    await w.runtime.tick();
    const a = (await w.latest(caseId))?.assessment;
    expect(a?.result).toBe("NOT_IMPROVING");
    expect(a?.reasonCodes).toContain("BACKUP_CAPACITY:BACKUP_NOT_OBSERVED_RUNNING");
  });
});

describe("V5 recurrence", () => {
  async function verified(w: World) {
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
    return caseId;
  }

  it("same hazard returns inside the watch window => same case REOPENED, count +1, new RiskEvent, no second case", async () => {
    const w = await makeWorld();
    const caseId = await verified(w);
    const before = await w.verifications(caseId);
    const firstEventId = (await w.runtime.cases.get(ORG, caseId))?.activeRiskEventId;

    // monitoring continues: ordinary normal data keeps the case verified
    await w.send("normal", 12);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
    expect(w.types().includes("recurrence.detected.v1")).toBe(false);

    // a single WATCH-level signal does not reopen
    await w.send("isolated-vibration", 5);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
    await w.send("normal", 3);

    await w.send("compound-outdoor-heat", 3);
    const cases = await w.runtime.cases.list(ORG);
    expect(cases).toHaveLength(1); // no second Risk Improvement Case
    const c = cases[0];
    expect(c).toMatchObject({ caseId, state: "REOPENED", recurrenceCount: 1 });
    expect(c?.activeRiskEventId).not.toBe(firstEventId);

    const events = await w.runtime.riskEvents.listByCase(ORG, caseId);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.eventId === firstEventId)?.state).toBe("VERIFIED");
    expect(events.find((e) => e.eventId === c?.activeRiskEventId)?.state).toMatch(
      /DETECTED|ALERTED/,
    );

    const rec = w.runtime.bus.history().find((e) => e.event_type === "recurrence.detected.v1");
    expect(rec?.payload).toMatchObject({
      caseId,
      previousRiskEventId: firstEventId,
      newRiskEventId: c?.activeRiskEventId,
      recurrenceCount: 1,
    });
    expect(w.types().filter((t) => t === "case.reopened.v1")).toHaveLength(1);
    // prior verification history is intact
    expect(await w.verifications(caseId)).toEqual(before);
    // the new event is alerted like any other
    expect(
      (await w.runtime.alerts.listByCase(ORG, caseId)).filter((a) => a.kind === "INITIAL"),
    ).toHaveLength(2);
    // intervention reflects the recurrence
    const v = await w.view(caseId);
    expect(v.stayingFixed).toMatchObject({ recurrenceCount: 1 });
    expect(v.stayingFixed.lastRecurrence.riskEventId).toBe(c?.activeRiskEventId);
    expect(v.intervention.level).toBe("RISK_ENGINEER_REVIEW");
    expect(w.runtime.bus.deadLetters()).toEqual([]);
  });

  it("a new action/verification cycle continues on the same reopened case", async () => {
    const w = await makeWorld();
    const caseId = await verified(w);
    await w.send("compound-outdoor-heat", 3);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("REOPENED");
    await w.reportAction(caseId); // acknowledge + assign + report on the NEW event
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c).toMatchObject({ state: "VERIFIED_IMPROVED", recurrenceCount: 1 });
    const history = await w.verifications(caseId);
    expect(history).toHaveLength(2);
    expect(history[0]?.eventId).not.toBe(history[1]?.eventId);
    expect(await w.runtime.cases.list(ORG)).toHaveLength(1);
  });

  it("outside the recurrence window the hazard opens a NEW case (no endless merging)", async () => {
    const w = await makeWorld();
    const caseId = await verified(w);
    w.clock.advance(2 * 3600 * 1000); // beyond the 1 h watch window
    await w.send("normal", 25);
    await w.send("compound-outdoor-heat", 3);
    const cases = await w.runtime.cases.list(ORG);
    expect(cases).toHaveLength(2);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
    expect(w.types().includes("recurrence.detected.v1")).toBe(false);
  });
});

describe("intervention recommendations API", () => {
  it("lists, reads and acknowledges recommendations; scoped and permissioned", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick();

    const list = await w.api("GET", "/api/v1/interventions", MGR);
    expect(list.status).toBe(200);
    const items = list.body.interventions as Json[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.filter((i) => i.status === "ACTIVE")).toHaveLength(1);
    expect(items.some((i) => i.status === "SUPERSEDED")).toBe(true);
    const active = items.find((i) => i.status === "ACTIVE") as Json;
    expect(active).toMatchObject({
      level: "REMOTE_REVIEW",
      policyId: "IPOL-RISK-ENGINEER-PRIORITIZATION",
      caseId,
    });
    expect(active.supportingEvidenceIds.length).toBeGreaterThan(0);

    expect((await w.api("GET", `/api/v1/interventions/${active.interventionId}`, MGR)).status).toBe(
      200,
    );
    expect((await w.api("GET", "/api/v1/interventions", OTHER)).body.interventions).toEqual([]);
    expect(
      (await w.api("GET", `/api/v1/interventions/${active.interventionId}`, OTHER)).status,
    ).toBe(404);
    expect((await w.api("GET", "/api/v1/interventions", OPERATOR)).status).toBe(403);
    expect(
      (await w.api("POST", `/api/v1/interventions/${active.interventionId}/acknowledge`, AUDITOR))
        .status,
    ).toBe(403);

    const ack = await w.api(
      "POST",
      `/api/v1/interventions/${active.interventionId}/acknowledge`,
      MGR,
    );
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: MGR });
    expect(
      (await w.api("POST", `/api/v1/interventions/${active.interventionId}/acknowledge`, MGR))
        .status,
    ).toBe(409);
    // acknowledging changes nothing about the case
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("NOT_IMPROVING");
  });

  it("other tenants cannot read a verification", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const id = (await w.latest(caseId))?.verificationId;
    expect((await w.api("GET", `/api/v1/verifications/${id}`, OTHER)).status).toBe(404);
    expect((await w.api("GET", `/api/v1/verifications/${id}`, MGR)).status).toBe(200);
  });
});
