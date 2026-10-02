import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import type { TenantDocumentStore } from "@symbiosis/repositories";
import { isSimulationScope } from "./facility";
import type { FacilityModel } from "./facility";
import type { ScenarioDefinition, ScenarioId, WeatherMode } from "./scenarios";
import {
  NORMAL_VALUES,
  applyPatch,
  isAbnormalForBaseline,
  validateStatePatch,
  valuesAt,
} from "./state";
import type { PhysicalValues, StatePatch, StateRevision } from "./state";

/**
 * Simulation session control (S10, D-091).
 *
 * Time. The simulation runs on REAL time (D-087): the platform's clocks and production policies are
 * untouched. A session is bounded to ONE tenant and facility (the simulation scope); every command
 * is refused for anything else. Nothing here can create or change a case, a risk event, an action, a
 * verification, evidence or sharing: this module holds a document store, an audit log and a purge
 * port, and nothing else (enforced by tests/unit/simulation-boundaries.test.ts).
 */
export const SAMPLE_INTERVAL_SECONDS = 5;
export const SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_SECONDS * 1000;
/** A browser that has not pulsed for this long is not "live". */
export const LIVE_WITHIN_SECONDS = 20;

export type SessionStatus = "RUNNING" | "STOPPED";

export type SimulationSession = {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  /** Incremented by every reset; a pulse carrying an older generation is refused. */
  readonly generation: number;
  readonly status: SessionStatus;
  /** Which preset was last applied, for display. `MANUAL` once a value was changed by hand. */
  readonly scenarioId: ScenarioId | "MANUAL";
  readonly weatherMode: WeatherMode;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  /** Latest state revision number. */
  readonly revision: number;
  /** Audit sequence when this generation began: the floor of the timeline. */
  readonly auditBase: number;
  /** Last 5-second instant that was sent. */
  readonly lastEmittedMs: number;
  /** Next request sequence number to hand out (shared by every simulated device; gaps are allowed). */
  readonly seqCursor: number;
  readonly lease?: { readonly holder: string; readonly untilMs: number };
  readonly pulses: number;
  readonly emitted: number;
  readonly rejected: number;
  readonly lastPulseAt?: string;
  readonly resets: number;
  /** Always REAL_TIME: the simulation does not shift the platform's time. */
  readonly clockMode: "REAL_TIME";
};

export type Scope = { readonly organizationId: string; readonly facilityId: string };
export type Actor = { readonly actorId: string };

export class SimulationError extends Error {
  constructor(
    readonly code:
      | "OUT_OF_SCOPE"
      | "INVALID_REQUEST"
      | "UNKNOWN_SCENARIO"
      | "REVISION_CONFLICT"
      | "BASELINE_LEARNING"
      | "NOT_RUNNING"
      | "CONFIRMATION_REQUIRED"
      | "BUSY"
      | "SESSION_RESET",
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = "SimulationError";
  }
}

/** Removes the simulation facility's domain records (cases, observations, ...). Provided by the composition root. */
export interface FacilityResetPort {
  purge(scope: Scope): Promise<Readonly<Record<string, number>>>;
}

export type Liveness = "LIVE" | "PAUSED" | "STOPPED";

export type SessionView = {
  readonly session: SimulationSession;
  readonly values: PhysicalValues;
  readonly liveness: Liveness;
  readonly clock: { readonly mode: "REAL_TIME"; readonly nowIso: string; readonly label: string };
};

export type ControlDeps = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: TenantDocumentStore;
  readonly audit: AuditLog;
  readonly facility: FacilityModel;
  readonly scenarios: readonly ScenarioDefinition[];
  readonly reset: FacilityResetPort;
  /** Whether every baseline of the simulation facility is READY (read-only). Absent: assume yes. */
  readonly baselinesReady?: (scope: Scope) => Promise<boolean>;
};

const CONTROL = "simulationControl" as const;
const STATES = "simulationStates" as const;

const sessionIdFor = (facilityId: string, generation: number) => `SIM-${facilityId}-G${generation}`;
const revisionDocId = (sessionId: string, revision: number) =>
  `${sessionId}-R${String(revision).padStart(6, "0")}`;
export const gridFloor = (ms: number) => Math.floor(ms / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;

const fmt = (v: unknown) =>
  typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v);

/** Human-readable list of what changed, for the audit trail. */
function diff(before: PhysicalValues, after: PhysicalValues): string[] {
  const out: string[] = [];
  for (const k of Object.keys(after) as (keyof PhysicalValues)[]) {
    if (k === "sensors") continue;
    if (before[k] !== after[k]) out.push(`${k}: ${fmt(before[k])} -> ${fmt(after[k])}`);
  }
  for (const g of Object.keys(after.sensors) as (keyof PhysicalValues["sensors"])[]) {
    const b = before.sensors[g];
    const a = after.sensors[g];
    if (b.health !== a.health) out.push(`${g}.health: ${b.health} -> ${a.health}`);
    if (b.staleSeconds !== a.staleSeconds)
      out.push(`${g}.staleSeconds: ${b.staleSeconds} -> ${a.staleSeconds}`);
    if (b.dropout !== a.dropout)
      out.push(`${g}.dropout: ${String(b.dropout)} -> ${String(a.dropout)}`);
  }
  return out;
}

export function createSimulationControl(deps: ControlDeps) {
  const { store, facility } = deps;
  const org = facility.organizationId;
  const fac = facility.facilityId;

  function requireScope(scope: Scope): void {
    // One tenant, one facility. Anything else does not exist for the simulation.
    if (!isSimulationScope(facility, scope.organizationId, scope.facilityId)) {
      throw new SimulationError("OUT_OF_SCOPE", "not a simulation facility");
    }
  }

  async function revisions(sessionId: string): Promise<StateRevision[]> {
    return [
      ...(await store.list<StateRevision>(STATES, org, { where: { sessionId }, limit: 1000 })),
    ].sort((a, b) => a.revision - b.revision);
  }

  async function readSession(): Promise<SimulationSession | undefined> {
    return store.get<SimulationSession>(CONTROL, org, fac);
  }

  async function ensureSession(by: string): Promise<SimulationSession> {
    const existing = await readSession();
    if (existing !== undefined) return existing;
    const now = deps.clock.nowMs();
    const sessionId = sessionIdFor(fac, 1);
    const session: SimulationSession = {
      sessionId,
      organizationId: org,
      facilityId: fac,
      generation: 1,
      status: "STOPPED",
      scenarioId: "NORMAL",
      weatherMode: "LIVE",
      startedBy: by,
      startedAt: nowIso(deps.clock),
      revision: 1,
      auditBase: await deps.audit.lastSequence(org),
      lastEmittedMs: gridFloor(now),
      // Epoch milliseconds: always above anything a previous run of these devices signed.
      seqCursor: now,
      pulses: 0,
      emitted: 0,
      rejected: 0,
      resets: 0,
      clockMode: "REAL_TIME",
    };
    const created = await store.create(CONTROL, org, fac, session);
    if (created) {
      await store.put(
        STATES,
        org,
        revisionDocId(sessionId, 1),
        {
          sessionId,
          revision: 1,
          atMs: now,
          values: NORMAL_VALUES,
          rampMs: 0,
          setBy: by,
          note: "Initial known-normal world",
        } satisfies StateRevision,
        { sessionId, revision: 1 },
      );
    }
    return (await readSession()) ?? session;
  }

  async function currentValues(session: SimulationSession, atMs: number): Promise<PhysicalValues> {
    return valuesAt(await revisions(session.sessionId), atMs);
  }

  function liveness(session: SimulationSession): Liveness {
    if (session.status !== "RUNNING") return "STOPPED";
    if (session.lastPulseAt === undefined) return "PAUSED";
    return deps.clock.nowMs() - Date.parse(session.lastPulseAt) <= LIVE_WITHIN_SECONDS * 1000
      ? "LIVE"
      : "PAUSED";
  }

  async function view(): Promise<SessionView> {
    const session = await ensureSession("SYSTEM");
    const now = deps.clock.nowMs();
    return {
      session,
      values: await currentValues(session, now),
      liveness: liveness(session),
      clock: {
        mode: "REAL_TIME",
        nowIso: new Date(now).toISOString(),
        label:
          "Real time. The simulation does not shift the platform's clock or any production policy.",
      },
    };
  }

  async function audit(
    by: string,
    action:
      | "SIMULATION_STARTED"
      | "SIMULATION_STATE_CHANGED"
      | "SIMULATION_SCENARIO_APPLIED"
      | "SIMULATION_RESET",
    session: SimulationSession,
    details: Record<string, string | number | boolean | string[]>,
    before?: string,
    after?: string,
  ) {
    await deps.audit.append({
      organizationId: org,
      facilityId: fac,
      actorId: by,
      actorType: "USER",
      action,
      targetType: "SIMULATION",
      targetId: session.sessionId,
      ...(before !== undefined && { beforeState: before }),
      ...(after !== undefined && { afterState: after }),
      correlationId: deps.ids.next("CORR"),
      at: nowIso(deps.clock),
      details,
    });
  }

  /** Records a new world state: atomically takes the next revision, then stores it. */
  async function record(
    by: string,
    values: PhysicalValues,
    rampMs: number,
    note: string,
    expectedRevision: number | undefined,
    extra: Partial<Pick<SimulationSession, "scenarioId" | "weatherMode">>,
  ): Promise<{ session: SimulationSession; revision: number; before: PhysicalValues }> {
    const session0 = await ensureSession(by);
    const now = deps.clock.nowMs();
    const history = await revisions(session0.sessionId);
    const before = valuesAt(history, now);
    let conflict = false;
    const updated = await store.update<SimulationSession>(CONTROL, org, fac, (cur) => {
      const c = cur ?? session0;
      if (expectedRevision !== undefined && c.revision !== expectedRevision) {
        conflict = true;
        return undefined;
      }
      conflict = false;
      return { doc: { ...c, revision: c.revision + 1, ...extra } };
    });
    if (conflict || updated === undefined) {
      throw new SimulationError(
        "REVISION_CONFLICT",
        "the simulation changed since this screen loaded; refresh and try again",
      );
    }
    const revision = updated.revision;
    const rev: StateRevision = {
      sessionId: updated.sessionId,
      revision,
      atMs: now,
      values,
      rampMs,
      ...(rampMs > 0 && { rampFrom: before }),
      setBy: by,
      note,
    };
    await store.put(STATES, org, revisionDocId(updated.sessionId, revision), rev, {
      sessionId: updated.sessionId,
      revision,
    });
    return { session: updated, revision, before };
  }

  async function guardBaseline(scope: Scope, next: PhysicalValues): Promise<void> {
    if (!isAbnormalForBaseline(next)) return;
    if (deps.baselinesReady === undefined || (await deps.baselinesReady(scope))) return;
    throw new SimulationError(
      "BASELINE_LEARNING",
      "The system is still learning what normal looks like. Keep the world normal until the baseline is READY, or abnormal readings would be learned as normal.",
    );
  }

  return {
    view,
    revisions: async () => revisions((await ensureSession("SYSTEM")).sessionId),
    ensureSession,
    scenarios: () => deps.scenarios,

    async start(scope: Scope, actor: Actor): Promise<SimulationSession> {
      requireScope(scope);
      const session = await ensureSession(actor.actorId);
      if (session.status === "RUNNING") return session;
      const now = deps.clock.nowMs();
      const updated = await store.update<SimulationSession>(CONTROL, org, fac, (cur) => {
        if (cur === undefined || cur.status === "RUNNING") return undefined;
        const { stoppedAt: _stoppedAt, ...rest } = cur;
        return {
          doc: {
            ...rest,
            status: "RUNNING",
            startedBy: actor.actorId,
            startedAt: new Date(now).toISOString(),
            // Never emit instants from before the start.
            lastEmittedMs: gridFloor(now),
          },
        };
      });
      const s = updated ?? session;
      await audit(
        actor.actorId,
        "SIMULATION_STARTED",
        s,
        { generation: s.generation },
        "STOPPED",
        "RUNNING",
      );
      return s;
    },

    async stop(scope: Scope, actor: Actor): Promise<SimulationSession> {
      requireScope(scope);
      const session = await ensureSession(actor.actorId);
      if (session.status === "STOPPED") return session;
      const updated = await store.update<SimulationSession>(CONTROL, org, fac, (cur) =>
        cur === undefined || cur.status === "STOPPED"
          ? undefined
          : { doc: { ...cur, status: "STOPPED", stoppedAt: nowIso(deps.clock) } },
      );
      return updated ?? session;
    },

    async applyScenario(
      scope: Scope,
      actor: Actor,
      scenarioId: string,
      options: { expectedRevision?: number; weatherMode?: WeatherMode } = {},
    ): Promise<{ session: SimulationSession; scenario: ScenarioDefinition }> {
      requireScope(scope);
      const scenario = deps.scenarios.find((s) => s.id === scenarioId);
      if (scenario === undefined) throw new SimulationError("UNKNOWN_SCENARIO", "unknown scenario");
      const session = await ensureSession(actor.actorId);
      const now = deps.clock.nowMs();
      const before = await currentValues(session, now);
      const next = applyPatch(before, scenario.values);
      if (scenario.id !== "NORMAL") await guardBaseline(scope, next);
      const mode = options.weatherMode ?? scenario.weatherMode;
      const r = await record(
        actor.actorId,
        next,
        scenario.rampSeconds * 1000,
        `Scenario ${scenario.id}`,
        options.expectedRevision,
        { scenarioId: scenario.id, weatherMode: mode },
      );
      await audit(
        actor.actorId,
        "SIMULATION_SCENARIO_APPLIED",
        r.session,
        {
          scenario: scenario.id,
          revision: r.revision,
          rampSeconds: scenario.rampSeconds,
          weatherMode: mode,
          changes: diff(r.before, next),
        },
        undefined,
        scenario.id,
      );
      return { session: r.session, scenario };
    },

    async setState(
      scope: Scope,
      actor: Actor,
      input: unknown,
      options: { expectedRevision?: number } = {},
    ): Promise<SimulationSession> {
      requireScope(scope);
      const checked = validateStatePatch(input);
      if (!checked.ok) {
        throw new SimulationError("INVALID_REQUEST", "the change is not valid", checked.issues);
      }
      const session = await ensureSession(actor.actorId);
      const before = await currentValues(session, deps.clock.nowMs());
      const next = applyPatch(before, checked.patch);
      const changes = diff(before, next);
      if (changes.length === 0)
        throw new SimulationError("INVALID_REQUEST", "nothing would change", ["no value differs"]);
      await guardBaseline(scope, next);
      const r = await record(
        actor.actorId,
        next,
        0,
        `Manual: ${changes.join("; ")}`,
        options.expectedRevision,
        {
          scenarioId: "MANUAL",
        },
      );
      await audit(actor.actorId, "SIMULATION_STATE_CHANGED", r.session, {
        revision: r.revision,
        changes,
      });
      return r.session;
    },

    async setWeatherMode(scope: Scope, actor: Actor, mode: unknown): Promise<SimulationSession> {
      requireScope(scope);
      if (mode !== "LIVE" && mode !== "SIMULATED") {
        throw new SimulationError("INVALID_REQUEST", "weather mode must be LIVE or SIMULATED");
      }
      const session = await ensureSession(actor.actorId);
      if (session.weatherMode === mode) return session;
      const updated = await store.update<SimulationSession>(CONTROL, org, fac, (cur) =>
        cur === undefined ? undefined : { doc: { ...cur, weatherMode: mode } },
      );
      const s = updated ?? session;
      await audit(actor.actorId, "SIMULATION_STATE_CHANGED", s, {
        weatherMode: mode,
        changes: [`weatherMode: ${session.weatherMode} -> ${mode}`],
      });
      return s;
    },

    /**
     * Resets the simulation facility to a known clean state. It removes only this facility's
     * simulation-owned records (through the purge port) and its own control-plane documents. The
     * audit log, policy versions, adapter versions, contacts and device records are kept. The
     * session ends STOPPED with a NEW generation, so a pulse from an old browser tab is refused.
     */
    async reset(scope: Scope, actor: Actor, confirmation: unknown): Promise<SimulationSession> {
      requireScope(scope);
      if (confirmation !== "RESET") {
        throw new SimulationError("CONFIRMATION_REQUIRED", "type RESET to confirm");
      }
      const session = await ensureSession(actor.actorId);
      // Take the pulse lease so no emission is in flight while the world is removed.
      const holder = deps.ids.next("RESET");
      const deadline = deps.clock.nowMs() + 15_000;
      for (;;) {
        let got = false;
        await store.update<SimulationSession>(CONTROL, org, fac, (cur) => {
          if (cur === undefined) return undefined;
          const free = cur.lease === undefined || cur.lease.untilMs <= deps.clock.nowMs();
          got = free;
          return free
            ? {
                doc: {
                  ...cur,
                  status: "STOPPED",
                  generation: cur.generation + 1,
                  lease: { holder, untilMs: deps.clock.nowMs() + 30_000 },
                },
              }
            : undefined;
        });
        if (got) break;
        if (deps.clock.nowMs() > deadline) {
          throw new SimulationError(
            "BUSY",
            "a simulation step is still running; try again in a moment",
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const scopeNow: Scope = { organizationId: org, facilityId: fac };
      const removed = { ...(await deps.reset.purge(scopeNow)) };
      // Control-plane documents of this facility's earlier generations.
      const sessions = await store.list<SimulationSession>("simulationSessions", org, {
        where: { facilityId: fac },
      });
      const sessionIds = new Set([session.sessionId, ...sessions.map((s) => s.sessionId)]);
      let states = 0;
      for (const sid of sessionIds) states += await store.purge(STATES, org, { sessionId: sid });
      removed.simulationStates = states;
      for (const c of [
        "adapterTraces",
        "notificationDeliveries",
        "followUpState",
        "ruleEvaluations",
      ] as const) {
        removed[c] = await store.purge(c, org, { facilityId: fac });
      }
      // Keep the finished session's summary, then start the new generation from known normal.
      await store.put(
        "simulationSessions",
        org,
        session.sessionId,
        { ...session, status: "STOPPED" },
        { facilityId: fac },
      );
      const generation = session.generation + 1;
      const now = deps.clock.nowMs();
      const nextId = sessionIdFor(fac, generation);
      const fresh: SimulationSession = {
        sessionId: nextId,
        organizationId: org,
        facilityId: fac,
        generation,
        status: "STOPPED",
        scenarioId: "NORMAL",
        weatherMode: "LIVE",
        startedBy: actor.actorId,
        startedAt: nowIso(deps.clock),
        revision: 1,
        auditBase: await deps.audit.lastSequence(org),
        lastEmittedMs: gridFloor(now),
        // Never lower: the replay guard remembers every sequence these devices already used.
        seqCursor: Math.max(now, (await readSession())?.seqCursor ?? 0),
        pulses: 0,
        emitted: 0,
        rejected: 0,
        resets: session.resets + 1,
        clockMode: "REAL_TIME",
      };
      await store.put(CONTROL, org, fac, fresh);
      await store.put(
        STATES,
        org,
        revisionDocId(nextId, 1),
        {
          sessionId: nextId,
          revision: 1,
          atMs: now,
          values: NORMAL_VALUES,
          rampMs: 0,
          setBy: actor.actorId,
          note: "Reset to the known-normal world",
        } satisfies StateRevision,
        { sessionId: nextId, revision: 1 },
      );
      await audit(
        actor.actorId,
        "SIMULATION_RESET",
        fresh,
        {
          generation,
          removed: Object.entries(removed).map(([k, v]) => `${k}: ${v}`),
        },
        session.sessionId,
        nextId,
      );
      return fresh;
    },
  };
}

export type SimulationControl = ReturnType<typeof createSimulationControl>;
