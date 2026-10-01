import { expect } from "vitest";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { Readings, ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime, LocalRuntimeOptions } from "../../scripts/local-runtime";

export const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
export const FAC = SYNTHETIC_DEV_DEVICE.facilityId;
export const MGR = "USR-FACILITY-MGR-001";
export const OPERATOR = "USR-OPERATOR-001";
export const ADMIN = "USR-ORG-ADMIN-001";
export const AUDITOR = "USR-AUDITOR-001";
export const OTHER_ORG_MGR = "USR-OTHER-ORG-MGR-001";
export const RE = "USR-RISK-ENGINEER-001";
export const UW = "USR-UNDERWRITER-001";
export const OTHER_INSURER = "USR-OTHER-INSURER-RE-001";
export const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

export type Json = ReturnType<typeof JSON.parse>;

/** The broad evidence grant (everything except raw telemetry). */
export const STANDARD_SCOPES = [
  "RECOMMENDATION",
  "EVENT_SUMMARY",
  "ACTION_SUMMARY",
  "BEFORE_AFTER_METRICS",
  "VERIFICATION_RESULT",
  "VERIFICATION_CONFIDENCE",
  "RECURRENCE_STATUS",
  "EVIDENCE_ARTIFACTS",
  "INTERVENTION_RECOMMENDATION",
];

const open: LocalRuntime[] = [];
export async function closeAll(): Promise<void> {
  for (const r of open.splice(0)) await r.close();
}

export async function makeWorld(options: Partial<LocalRuntimeOptions> = {}) {
  const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  const runtime = await createLocalRuntime({
    clock,
    ids: new SequentialIdGenerator(),
    consoleSink: () => {},
    ...options,
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
        notes: "operator note that must stay internal",
      });
      expect(report.status).toBe(200);
      return actionId;
    },
    /** detect -> acknowledge -> report -> verify with trusted data => VERIFIED_IMPROVED. */
    async verified() {
      const caseId = await w.detect();
      await w.reportAction(caseId);
      await runtime.tick();
      await w.send("normal", 25);
      await runtime.tick();
      expect((await runtime.cases.get(ORG, caseId))?.state).toBe("VERIFIED_IMPROVED");
      return caseId;
    },
    async grant(actor: string, body: Record<string, unknown> = {}) {
      return api("POST", "/api/v1/sharing-agreements", actor, {
        recipientOrganizationId: "ORG-INS-001",
        facilityIds: [FAC],
        scopes: STANDARD_SCOPES,
        ...body,
      });
    },
    async html(path: string, init?: { method?: string; form?: Record<string, string | string[]> }) {
      const body =
        init?.form === undefined
          ? undefined
          : new URLSearchParams(
              Object.entries(init.form).flatMap(([k, v]) =>
                (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
              ),
            ).toString();
      const res = await fetch(`${runtime.server.baseUrl}${path}`, {
        method: init?.method ?? "GET",
        redirect: "manual",
        ...(body !== undefined && {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      });
      return { status: res.status, text: await res.text(), location: res.headers.get("location") };
    },
    async latestPackage(caseId: string) {
      const c = await runtime.cases.get(ORG, caseId);
      return runtime.evidencePackages.get(ORG, c?.latestEvidencePackageId ?? "");
    },
  };
  return w;
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
