import { FakeEmailTransport } from "@symbiosis/adapter-email";
import { ManualClock } from "@symbiosis/clock";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { expect } from "vitest";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime } from "../../scripts/local-runtime";

/**
 * The Facility Simulation through the REAL pipeline (S10, D-086): a simulated world is turned into
 * signed vendor payloads, accepted at the edge, mapped by a versioned adapter, assessed, judged by
 * the deterministic rule, and everything after that (case, alert, acknowledgement, action,
 * verification, follow-up, evidence, recurrence) is the unchanged S3 to S9 code. Nothing in this
 * file creates a case or a verification result: it only sets the physical world and clicks as people.
 */
export const ORG = "ORG-SIM-001";
export const FAC = "FAC-SIM-PHX-01";
export const ADMIN = "USR-ORG-ADMIN-001";
export const MGR = "USR-FACILITY-MGR-001";
export const OPERATOR = "USR-OPERATOR-001";
export const AUDITOR = "USR-AUDITOR-001";
export const OTHER = "USR-OTHER-ORG-MGR-001";
export const INSURER = "USR-RISK-ENGINEER-001";
export const BACKUP = "ACT-COOLING-START-BACKUP";
export const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

export type Json = ReturnType<typeof JSON.parse>;

const open: LocalRuntime[] = [];
export async function closeAllWorlds() {
  for (const r of open.splice(0)) await r.close();
}

export async function makeSimWorld(options: { transport?: FakeEmailTransport } = {}) {
  // aligned to the 5-second sample grid
  const clock = new ManualClock(Date.parse("2026-10-02T10:00:00.000Z"));
  const transport = options.transport ?? new FakeEmailTransport();
  const runtime = await createLocalRuntime({
    clock,
    ids: new SequentialIdGenerator(),
    consoleSink: () => {},
    emailTransport: transport,
    webBaseUrl: "https://app.example",
  });
  open.push(runtime);

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
  const sim = (method: string, rest: string, actor = ADMIN, body?: unknown) =>
    api(method, `/api/v1/simulation${rest}`, actor, body);

  const w = {
    runtime,
    clock,
    transport,
    api,
    sim,
    emails: () => transport.outbox,
    overview: async (actor = ADMIN) => (await sim("GET", "", actor)).body,
    async scenario(id: string) {
      const r = await sim("POST", "/scenario", ADMIN, { scenarioId: id });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    },
    /** Advances real(ish) time in 5-second steps, pulsing the simulation each step. */
    async steps(count: number, options: { tick?: boolean } = {}) {
      for (let i = 0; i < count; i += 1) {
        w.clock.advance(5000);
        const r = await sim("POST", "/pulse", ADMIN, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.rejected, JSON.stringify(r.body)).toEqual([]);
        if (options.tick === true) await runtime.tick();
      }
    },
    async until(predicate: () => Promise<boolean>, max = 80, tick = true) {
      for (let i = 0; i < max; i += 1) {
        if (await predicate()) return i;
        await w.steps(1, { tick });
      }
      throw new Error("condition not reached");
    },
    cases: () => runtime.cases.list(ORG).then((l) => l.filter((c) => c.facilityId === FAC)),
    async start() {
      expect((await sim("POST", "/session/start")).status).toBe(200);
    },
    /** A normal world until the baselines are READY (needed before anything abnormal). */
    async warmUp() {
      await w.start();
      await w.scenario("NORMAL");
      await w.until(async () => (await w.overview()).baseline.ready === true, 60, false);
    },
    async detect() {
      await w.warmUp();
      await w.scenario("COMPOUND_COOLING_RISK");
      await w.until(async () => (await w.cases()).length > 0, 60, false);
      const [c] = await w.cases();
      return (c as { caseId: string }).caseId;
    },
    async reportAction(caseId: string, library = BACKUP, acknowledge = true) {
      if (acknowledge) {
        expect((await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {})).status).toBe(200);
      }
      const assign = await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
        actionLibraryId: library,
        assigneeId: OPERATOR,
      });
      expect(assign.status, JSON.stringify(assign.body)).toBe(201);
      const report = await api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
        actionLibraryId: library,
        actionId: assign.body.actionId,
        notes: "done",
      });
      expect(report.status, JSON.stringify(report.body)).toBe(200);
    },
    caseView: async (id: string) => (await api("GET", `/api/v1/cases/${id}`, MGR)).body,
    verifications: (id: string) => runtime.verifications.listByCase(ORG, id),
  };
  return w;
}
export type SimWorld = Awaited<ReturnType<typeof makeSimWorld>>;

