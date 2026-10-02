import type { AdapterTrace, NotificationDelivery } from "@symbiosis/contracts";
import { can } from "@symbiosis/authz";
import type { Permission } from "@symbiosis/authz";
import type { Clock } from "@symbiosis/clock";
import type { WeatherService } from "@symbiosis/adapter-weather";
import type { AuditLog } from "@symbiosis/audit";
import type { IdGenerator } from "@symbiosis/event-bus";
import { applySourceMapping, describeMapping, parseSourceMapping } from "@symbiosis/normalization";
import type { AdapterCatalog } from "@symbiosis/normalization";
import type { DeliveryStore } from "@symbiosis/notifications";
import {
  NUMERIC_BOUNDS,
  STALE_SECONDS_MAX,
  SENSOR_GROUP_NAMES,
  SimulationError,
  buildVendorPayload,
} from "@symbiosis/simulation";
import type {
  FacilityModel,
  ScenarioDefinition,
  SimulationControl,
  SimulationEngine,
} from "@symbiosis/simulation";
import { canAccessFacility } from "@symbiosis/tenancy";
import type { ActorContext } from "@symbiosis/tenancy";
import type { EdgeResponse } from "./edge-handler";
import type { SimulationViews } from "./simulation-views";

/**
 * HTTP surface of the Facility Simulation (S10, D-091): `/api/v1/simulation/*`.
 *
 * Authority. Every route requires the actor to belong to the simulation tenant and facility (anyone
 * else gets the same 404 as for an unknown route), then a permission. The browser's coordinates,
 * ids and roles are never trusted: scope comes from the server-side directory. This file validates
 * a request, calls the control plane, the engine or a read model, and maps typed errors to HTTP. It
 * calls no domain command: it cannot create or change a case, a verification or evidence.
 */
export type PolicyServiceApi = {
  view(): Promise<{
    readonly label: string;
    readonly note: string;
    readonly parameters: readonly Record<string, unknown>[];
    readonly active: {
      readonly version: number;
      readonly label: string;
      readonly values: Readonly<Record<string, number>>;
      readonly createdBy: string;
      readonly createdAt: string;
      readonly reason: string;
      readonly builtin: boolean;
    };
    readonly versions: readonly Record<string, unknown>[];
    readonly defaults: Readonly<Record<string, number>>;
  }>;
  publish(
    actorId: string,
    values: unknown,
    reason: unknown,
  ): Promise<
    | { readonly ok: true; readonly version: number }
    | { readonly ok: false; readonly code: string; readonly issues: readonly string[] }
  >;
  activate(actorId: string, version: number, reason: string): Promise<boolean>;
};

export type SimulationApiDeps = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly facility: FacilityModel;
  readonly scenarios: readonly ScenarioDefinition[];
  readonly control: SimulationControl;
  readonly engine: SimulationEngine;
  readonly weather: WeatherService;
  readonly policies: PolicyServiceApi;
  readonly catalog: AdapterCatalog;
  readonly views: SimulationViews;
  readonly audit: AuditLog;
  readonly deliveries: Pick<DeliveryStore, "listByCase">;
  /** The same case listing the operations API uses (already scoped to the actor). */
  readonly listCases: (actor: ActorContext) => Promise<
    readonly {
      readonly caseId: string;
      readonly title: string;
      readonly severity: string;
      readonly state: string;
      readonly facilityId: string;
      readonly createdAt?: string;
      readonly riskEventState?: string;
      readonly didItWork?: string;
    }[]
  >;
  /** Runs the scheduler pass now (cloud: asks the worker). Absent: the route does not exist. */
  readonly tick?: () => Promise<unknown>;
};

export type SimulationRequest = {
  readonly actor: ActorContext;
  readonly method: string;
  /** The path after `/api/v1/simulation`. */
  readonly route: readonly string[];
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
};

const json = (status: number, body: unknown): EdgeResponse => ({ status, body });
const problem = (status: number, code: string, message: string, issues?: readonly string[]) =>
  json(status, { error: { code, message, ...(issues !== undefined && { issues }) } });

const HTTP: Record<SimulationError["code"], number> = {
  OUT_OF_SCOPE: 404,
  INVALID_REQUEST: 400,
  UNKNOWN_SCENARIO: 400,
  REVISION_CONFLICT: 409,
  BASELINE_LEARNING: 409,
  NOT_RUNNING: 409,
  CONFIRMATION_REQUIRED: 400,
  BUSY: 409,
  SESSION_RESET: 409,
};

/** Equivalence of two sources' canonical values for the same reading (resolution, not meaning). */
const EQUIVALENCE_ABSOLUTE = 1e-3;
const EQUIVALENCE_RELATIVE = 1e-3;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

const publicSession = (s: Awaited<ReturnType<SimulationControl["view"]>>["session"]) => ({
  sessionId: s.sessionId,
  generation: s.generation,
  status: s.status,
  scenarioId: s.scenarioId,
  weatherMode: s.weatherMode,
  startedBy: s.startedBy,
  startedAt: s.startedAt,
  ...(s.stoppedAt !== undefined && { stoppedAt: s.stoppedAt }),
  revision: s.revision,
  pulses: s.pulses,
  emitted: s.emitted,
  rejected: s.rejected,
  ...(s.lastPulseAt !== undefined && { lastPulseAt: s.lastPulseAt }),
  resets: s.resets,
  clockMode: s.clockMode,
});

export function createSimulationApi(deps: SimulationApiDeps) {
  const { facility } = deps;
  let lastTickMs = 0;
  let policyCache: { at: number; view: Awaited<ReturnType<PolicyServiceApi["view"]>> } | undefined;

  const scopeOf = () => ({
    organizationId: facility.organizationId,
    facilityId: facility.facilityId,
  });

  async function policyView() {
    const now = deps.clock.nowMs();
    if (policyCache === undefined || now - policyCache.at > 3000) {
      policyCache = { at: now, view: await deps.policies.view() };
    }
    return policyCache.view;
  }

  async function profileVersions(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const p of await deps.catalog.listProfiles(facility.organizationId))
      m.set(p.profileId, p.activeVersion);
    return m;
  }

  async function overview(actor: ActorContext) {
    const v = await deps.control.view();
    const weatherView = await deps.weather.view({
      ...scopeOf(),
      location: facility.location,
      mode: v.session.weatherMode,
    });
    const weatherLabel = {
      synthetic: weatherView.status === "SIMULATED",
      live: weatherView.live,
      label:
        weatherView.status === "LIVE"
          ? "LIVE WEATHER"
          : weatherView.status === "SIMULATED"
            ? "SIMULATED WEATHER"
            : weatherView.status === "STALE"
              ? "WEATHER STALE"
              : "WEATHER UNAVAILABLE",
    };
    const policy = await policyView();
    const [sensors, baseline, devices, rule, cases] = await Promise.all([
      deps.views.sensors(weatherLabel),
      deps.views.baselineStatus(),
      profileVersions().then((pv) => deps.views.devices(pv)),
      deps.views.rule(policy.active.values, { source: weatherLabel.label }),
      deps.listCases(actor),
    ]);
    const mine = cases
      .filter((c) => c.facilityId === facility.facilityId)
      .sort((x, y) => Date.parse(x.createdAt ?? "") - Date.parse(y.createdAt ?? ""));
    const active = [...mine].reverse().find((c) => c.state !== "CLOSED");
    const deliveries: readonly NotificationDelivery[] =
      active === undefined
        ? []
        : await deps.deliveries.listByCase(facility.organizationId, active.caseId);
    return {
      facility: {
        facilityId: facility.facilityId,
        name: facility.name,
        description: facility.description,
        location: { label: facility.location.label },
        assets: facility.assets,
      },
      session: publicSession(v.session),
      liveness: v.liveness,
      clock: v.clock,
      values: v.values,
      bounds: {
        numeric: NUMERIC_BOUNDS,
        staleSecondsMax: STALE_SECONDS_MAX,
        sensorGroups: SENSOR_GROUP_NAMES,
      },
      scenarios: deps.scenarios.map((s) => ({
        id: s.id,
        label: s.label,
        summary: s.summary,
        world: s.world,
        expectation: s.expectation,
        rampSeconds: s.rampSeconds,
        weatherMode: s.weatherMode,
      })),
      weather: { ...weatherView, label: weatherView.label, display: weatherLabel.label },
      sensors,
      devices,
      baseline,
      rule,
      policy: {
        label: policy.label,
        activeVersion: policy.active.version,
        activeLabel: policy.active.label,
        note: policy.note,
      },
      cases: mine,
      activeCaseId: active?.caseId ?? null,
      notifications: deliveries
        .map((d) => ({
          deliveryId: d.deliveryId,
          kind: d.alertKind,
          recipientRole: d.recipientRole ?? null,
          recipientRef: d.recipientRef,
          addressHint: d.addressHint ?? null,
          channel: d.channel,
          status: d.status,
          attempt: d.attempt,
          subject: d.subject,
          requestedAt: d.requestedAt,
          completedAt: d.completedAt ?? null,
          failure: d.failure ?? null,
        }))
        .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)),
      permissions: {
        control: can(actor, "SIMULATION_CONTROL"),
        editPolicy: can(actor, "SIMULATION_POLICY_EDIT"),
        editAdapters: can(actor, "SIMULATION_ADAPTER_EDIT"),
        reset: can(actor, "SIMULATION_RESET"),
      },
    };
  }

  /** Allowed assets and signals for a dry run: the devices bound to the profile, else the whole facility. */
  function previewContext(profileId: string) {
    const bound = facility.devices.filter((d) => d.profileId === profileId);
    const devices = bound.length > 0 ? bound : facility.devices;
    const assets = new Set<string>();
    const signals = new Set<string>();
    for (const d of devices) {
      assets.add(d.assetId);
      for (const a of Object.values(d.assetMapping?.bySignal ?? {})) assets.add(a);
      for (const a of Object.values(d.assetMapping?.byField ?? {})) assets.add(a);
      for (const s of d.expectedSignals) signals.add(s);
    }
    return {
      deviceId: bound[0]?.deviceId ?? "DEV-PREVIEW",
      allowedAssetIds: [...assets],
      expectedSignals: [...signals] as never,
    };
  }

  async function dryRun(
    profileId: string,
    version: number | undefined,
    payload: unknown,
  ): Promise<AdapterTrace | undefined> {
    const rec =
      version === undefined
        ? await deps.catalog
            .getActive(facility.organizationId, profileId)
            .then((d) => (d === undefined ? undefined : { definition: d }))
        : await deps.catalog.getVersion(facility.organizationId, profileId, version);
    if (rec === undefined) return undefined;
    const def = rec.definition;
    const ctx = previewContext(profileId);
    const receivedAt = new Date(deps.clock.nowMs()).toISOString();
    const out = applySourceMapping(def, payload, {
      organizationId: facility.organizationId,
      facilityId: facility.facilityId,
      deviceId: ctx.deviceId,
      expectedSignals: ctx.expectedSignals,
      allowedAssetIds: ctx.allowedAssetIds,
      receivedAt,
    });
    const accepted = out.fields.filter((f) => f.status === "ACCEPTED").length;
    return {
      traceId: `DRY-${profileId}-${deps.clock.nowMs()}`,
      organizationId: facility.organizationId,
      facilityId: facility.facilityId,
      deviceId: ctx.deviceId,
      profileId,
      version: def.version,
      sourceType: def.sourceType,
      synthetic: def.synthetic,
      mode: "DRY_RUN",
      receivedAt,
      ...(out.observedAt !== undefined && { observedAt: out.observedAt }),
      payload,
      fields: out.fields,
      accepted,
      rejected: out.fields.length - accepted,
      duplicatesDropped: 0,
      outcome: accepted === 0 ? "REJECTED" : accepted < out.fields.length ? "PARTIAL" : "ACCEPTED",
      issues: out.issues,
    };
  }

  /** A vendor sample of the CURRENT simulated world at the latest 5-second instant. */
  async function sampleFor(profileId: string, instantMs?: number) {
    const v = await deps.control.view();
    const at = instantMs ?? Math.floor(deps.clock.nowMs() / 5000) * 5000;
    const group = facility.devices.find((d) => d.profileId === profileId)?.group;
    return buildVendorPayload(profileId, group, {
      seed: v.session.sessionId,
      values: v.values,
      instantMs: at,
    });
  }

  const observationsOf = (t: AdapterTrace | undefined) =>
    (t?.fields ?? [])
      .filter((f) => f.status === "ACCEPTED")
      .map((f) => ({
        assetId: f.assetId ?? "",
        signal: f.signal,
        value: f.canonicalValue ?? null,
        unit: f.canonicalUnit,
      }));
  const rounded = (v: number | boolean | null) =>
    typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v;

  return async (req: SimulationRequest): Promise<EdgeResponse> => {
    const { actor, method, route, body } = req;
    // Scope first: anyone outside the simulation tenant and facility sees "not found".
    if (
      actor.organizationId !== facility.organizationId ||
      !canAccessFacility(actor, facility.facilityId)
    ) {
      return problem(404, "NOT_FOUND", "Unknown route");
    }
    const need = (p: Permission): EdgeResponse | undefined =>
      can(actor, p) ? undefined : problem(403, "FORBIDDEN", `Missing permission ${p}`);
    const read = need("SIMULATION_READ");
    if (read !== undefined) return read;
    const [a, b, c] = route;
    const by = { actorId: actor.actorId };

    try {
      // ---- reads ---------------------------------------------------------------------------
      if (method === "GET" && route.length === 0) return json(200, await overview(actor));

      if (method === "GET" && a === "timeline" && route.length === 1) {
        const v = await deps.control.view();
        const limit = Math.min(200, Math.max(10, Number(req.query.get("limit") ?? 80) || 80));
        return json(200, { items: await deps.views.timeline(v.session.auditBase, limit) });
      }

      if (method === "GET" && a === "series" && route.length === 1) {
        const seconds = Math.min(
          1800,
          Math.max(60, Number(req.query.get("seconds") ?? 600) || 600),
        );
        return json(200, await deps.views.series(seconds));
      }

      if (method === "GET" && a === "policy" && route.length === 1) {
        return json(200, await deps.policies.view());
      }

      if (method === "GET" && a === "adapters" && route.length === 1) {
        const profiles = await deps.catalog.listProfiles(facility.organizationId);
        const out = [];
        for (const p of profiles) {
          const def = await deps.catalog.getActive(facility.organizationId, p.profileId);
          const sample = await sampleFor(p.profileId);
          out.push({
            ...p,
            definition: def,
            mapping: def === undefined ? [] : describeMapping(def),
            samplePayload: sample?.payload ?? null,
            boundDevices: facility.devices
              .filter((d) => d.profileId === p.profileId)
              .map((d) => ({ deviceId: d.deviceId, displayName: d.displayName })),
            recentTraces: await deps.views.traces(p.profileId, 5),
          });
        }
        return json(200, { profiles: out });
      }

      if (method === "GET" && a === "adapters" && b === "compare" && route.length === 2) {
        const at = Math.floor(deps.clock.nowMs() / 5000) * 5000;
        const left = "sim-bas-gateway";
        const right = ["sim-vibration-gateway", "sim-electrical-meter"];
        const run = async (id: string) => {
          const s = await sampleFor(id, at);
          const t = s === undefined ? undefined : await dryRun(id, undefined, s.payload);
          return { profileId: id, payload: s?.payload ?? null, trace: t ?? null };
        };
        const l = await run(left);
        const r = await Promise.all(right.map(run));
        const canon = (rows: { trace: AdapterTrace | null }[]) =>
          new Map(
            rows
              .flatMap((x) => observationsOf(x.trace ?? undefined))
              .filter((o) => o.signal === "vibration_rms" || o.signal === "current")
              .map((o) => [`${o.assetId}|${o.signal}|${o.unit}`, o.value] as const),
          );
        const lc = canon([l]);
        const rc = canon(r);
        // Two sources describe the same physical reading at their own resolution (one rounds to four
        // decimals, another converts from a different unit), so "equivalent" means: the same asset,
        // signal and canonical unit, and values equal within the stated tolerance.
        const equal = (
          a: number | boolean | null | undefined,
          b: number | boolean | null | undefined,
        ) =>
          typeof a === "number" && typeof b === "number"
            ? Math.abs(a - b) <= Math.max(EQUIVALENCE_ABSOLUTE, EQUIVALENCE_RELATIVE * Math.abs(a))
            : a === b;
        const keys = [...lc.keys()].sort();
        const equivalent =
          keys.length > 0 &&
          keys.length === rc.size &&
          keys.every((k) => rc.has(k) && equal(lc.get(k), rc.get(k)));
        return json(200, {
          instantAt: new Date(at).toISOString(),
          flat: l,
          specialized: r,
          equivalent,
          tolerance: { absolute: EQUIVALENCE_ABSOLUTE, relative: EQUIVALENCE_RELATIVE },
          compared: keys.map((k) => `${k}|${String(rounded(lc.get(k) ?? null))}`),
        });
      }

      // ---- adapter lab (dry run: nothing is ingested) -------------------------------------------
      if (method === "POST" && a === "adapters" && b === "preview" && route.length === 2) {
        const profileId = typeof body.profileId === "string" ? body.profileId : "";
        if (!PROFILE_ID.test(profileId))
          return problem(400, "INVALID_REQUEST", "profileId is required");
        const version = body.version === undefined ? undefined : Number(body.version);
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
          return problem(400, "INVALID_REQUEST", "version must be a positive integer");
        }
        let payload: unknown = body.payload;
        if (payload === undefined) {
          const s = await sampleFor(profileId);
          if (s === undefined) return problem(404, "NOT_FOUND", "unknown profile");
          payload = s.payload;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return problem(400, "INVALID_REQUEST", "payload must be a JSON object");
        }
        if (JSON.stringify(payload).length > 16_384)
          return problem(413, "TOO_LARGE", "payload is too large for a preview");
        const trace = await dryRun(profileId, version, payload);
        if (trace === undefined) return problem(404, "NOT_FOUND", "unknown profile or version");
        return json(200, { trace, observations: observationsOf(trace) });
      }

      // Validation only: tells the editor what is wrong before anything is published.
      if (method === "POST" && a === "adapters" && b === "validate" && route.length === 2) {
        const r = parseSourceMapping(body.definition);
        return json(200, r.ok ? { valid: true, issues: [] } : { valid: false, issues: r.issues });
      }

      if (method === "POST" && a === "adapters" && b === "publish" && route.length === 2) {
        const denied = need("SIMULATION_ADAPTER_EDIT");
        if (denied !== undefined) return denied;
        const reason = typeof body.reason === "string" ? body.reason : "";
        const r = await deps.catalog.publish(facility.organizationId, body.definition, {
          actorId: actor.actorId,
          reason,
          at: new Date(deps.clock.nowMs()).toISOString(),
        });
        if (!r.ok)
          return problem(
            r.code === "UNKNOWN_PROFILE" ? 404 : 400,
            r.code,
            "The mapping was not accepted",
            r.issues,
          );
        const profileId = (body.definition as { profileId: string }).profileId;
        await deps.audit.append({
          organizationId: facility.organizationId,
          facilityId: facility.facilityId,
          actorId: actor.actorId,
          actorType: "USER",
          action: "ADAPTER_MAPPING_PUBLISHED",
          targetType: "ADAPTER",
          targetId: `${profileId}@v${r.version}`,
          correlationId: deps.ids.next("CORR"),
          at: new Date(deps.clock.nowMs()).toISOString(),
          details: { profileId, version: r.version, reason: reason.slice(0, 300) },
        });
        return json(201, { profileId, version: r.version });
      }

      if (method === "POST" && a === "adapters" && b === "activate" && route.length === 2) {
        const denied = need("SIMULATION_ADAPTER_EDIT");
        if (denied !== undefined) return denied;
        const profileId = typeof body.profileId === "string" ? body.profileId : "";
        const version = Number(body.version);
        if (!PROFILE_ID.test(profileId) || !Number.isInteger(version) || version < 1) {
          return problem(400, "INVALID_REQUEST", "profileId and version are required");
        }
        if (!(await deps.catalog.activate(facility.organizationId, profileId, version))) {
          return problem(404, "NOT_FOUND", "unknown profile or version");
        }
        await deps.audit.append({
          organizationId: facility.organizationId,
          facilityId: facility.facilityId,
          actorId: actor.actorId,
          actorType: "USER",
          action: "ADAPTER_MAPPING_ACTIVATED",
          targetType: "ADAPTER",
          targetId: `${profileId}@v${version}`,
          correlationId: deps.ids.next("CORR"),
          at: new Date(deps.clock.nowMs()).toISOString(),
          details: { profileId, version },
        });
        return json(200, { profileId, version });
      }

      // ---- policy -------------------------------------------------------------------------------
      if (method === "POST" && a === "policy" && route.length === 1) {
        const denied = need("SIMULATION_POLICY_EDIT");
        if (denied !== undefined) return denied;
        const r = await deps.policies.publish(actor.actorId, body.values, body.reason);
        policyCache = undefined;
        return r.ok
          ? json(201, { version: r.version })
          : problem(400, r.code, "The policy change was not accepted", r.issues);
      }
      if (method === "POST" && a === "policy" && b === "activate" && route.length === 2) {
        const denied = need("SIMULATION_POLICY_EDIT");
        if (denied !== undefined) return denied;
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1)
          return problem(400, "INVALID_REQUEST", "version is required");
        const ok = await deps.policies.activate(
          actor.actorId,
          version,
          typeof body.reason === "string" ? body.reason : "",
        );
        policyCache = undefined;
        return ok ? json(200, { version }) : problem(404, "NOT_FOUND", "unknown version");
      }

      // ---- control (the simulated world) ----------------------------------------------------------
      if (
        method === "POST" &&
        a === "session" &&
        (b === "start" || b === "stop") &&
        route.length === 2
      ) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        const s =
          b === "start"
            ? await deps.control.start(scopeOf(), by)
            : await deps.control.stop(scopeOf(), by);
        return json(200, publicSession(s));
      }
      if (method === "POST" && a === "scenario" && route.length === 1) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        if (typeof body.scenarioId !== "string")
          return problem(400, "INVALID_REQUEST", "scenarioId is required");
        const mode = body.weatherMode;
        if (mode !== undefined && mode !== "LIVE" && mode !== "SIMULATED") {
          return problem(400, "INVALID_REQUEST", "weatherMode must be LIVE or SIMULATED");
        }
        const rev = body.expectedRevision;
        if (rev !== undefined && (!Number.isInteger(rev) || (rev as number) < 1)) {
          return problem(400, "INVALID_REQUEST", "expectedRevision must be a positive integer");
        }
        const r = await deps.control.applyScenario(scopeOf(), by, body.scenarioId, {
          ...(rev !== undefined && { expectedRevision: rev as number }),
          ...(mode !== undefined && { weatherMode: mode }),
        });
        return json(200, { session: publicSession(r.session) });
      }
      if (method === "POST" && a === "state" && route.length === 1) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        const rev = body.expectedRevision;
        if (rev !== undefined && (!Number.isInteger(rev) || (rev as number) < 1)) {
          return problem(400, "INVALID_REQUEST", "expectedRevision must be a positive integer");
        }
        const s = await deps.control.setState(scopeOf(), by, body.patch, {
          ...(rev !== undefined && { expectedRevision: rev as number }),
        });
        return json(200, { session: publicSession(s) });
      }
      if (method === "POST" && a === "weather" && route.length === 1) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        const s = await deps.control.setWeatherMode(scopeOf(), by, body.mode);
        return json(200, { session: publicSession(s) });
      }
      if (method === "POST" && a === "pulse" && route.length === 1) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        const gen = body.generation;
        if (gen !== undefined && (!Number.isInteger(gen) || (gen as number) < 1)) {
          return problem(400, "INVALID_REQUEST", "generation must be a positive integer");
        }
        const r = await deps.engine.pulse(scopeOf(), gen as number | undefined);
        return json(200, r);
      }
      if (method === "POST" && a === "tick" && route.length === 1) {
        const denied = need("SIMULATION_CONTROL");
        if (denied !== undefined) return denied;
        if (deps.tick === undefined) return problem(404, "NOT_FOUND", "Unknown route");
        const now = deps.clock.nowMs();
        if (now - lastTickMs < 8000)
          return problem(429, "TOO_MANY_REQUESTS", "checks were just run; wait a few seconds");
        lastTickMs = now;
        await deps.tick();
        return json(200, { ran: true, at: new Date(now).toISOString() });
      }
      if (method === "POST" && a === "reset" && route.length === 1) {
        const denied = need("SIMULATION_RESET");
        if (denied !== undefined) return denied;
        const s = await deps.control.reset(scopeOf(), by, body.confirm);
        policyCache = undefined;
        return json(200, { session: publicSession(s) });
      }
      void c;
      return problem(404, "NOT_FOUND", "Unknown route");
    } catch (error) {
      if (error instanceof SimulationError) {
        return problem(HTTP[error.code], error.code, error.message, error.issues);
      }
      throw error;
    }
  };
}

export type SimulationApi = ReturnType<typeof createSimulationApi>;
