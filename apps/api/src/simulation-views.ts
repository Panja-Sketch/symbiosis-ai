import type {
  AdapterTrace,
  AuditEntry,
  CanonicalObservation,
  CanonicalSignal,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import type { Clock } from "@symbiosis/clock";
import type { DeviceRegistry } from "@symbiosis/device-registry";
import type { AdapterCatalog } from "@symbiosis/normalization";
import type {
  BaselineRepository,
  ObservationRepository,
  TenantDocumentStore,
} from "@symbiosis/repositories";
import type { FacilityModel } from "@symbiosis/simulation";

/**
 * Read models for the Facility Simulation workspace (S10, D-091). Everything here is READ ONLY: it
 * assembles facts the deterministic pipeline already stored (observations, baselines, what the rule
 * concluded, the audit trail) into the shapes a screen needs. It never decides a state, recomputes a
 * rule, or writes anything.
 */
export type ViewDeps = {
  readonly clock: Clock;
  readonly facility: FacilityModel;
  readonly observations: Pick<ObservationRepository, "listForWindow">;
  readonly baselines: Pick<BaselineRepository, "listActive">;
  readonly registry: Pick<DeviceRegistry, "listForFacility">;
  readonly audit: Pick<AuditLog, "listAfter">;
  readonly store: TenantDocumentStore;
  readonly catalog: AdapterCatalog;
};

export type SensorStatus = "NORMAL" | "WARNING" | "CRITICAL" | "LEARNING" | "NO_DATA" | "UNTRUSTED";

export type SensorView = {
  readonly sensorId: string;
  readonly name: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly signal: CanonicalSignal;
  readonly group: string;
  readonly value: number | boolean | null;
  readonly unit: string;
  readonly observedAt: string | null;
  readonly ageSeconds: number | null;
  readonly confidence: number | null;
  readonly trusted: boolean | null;
  readonly trustNote: string | null;
  readonly status: SensorStatus;
  readonly sourceType: string | null;
  readonly sourceAdapter: string | null;
  readonly deviceId: string | null;
  /** The vendor profile or provider label, for display ("Vibration Sensor Gateway", "LIVE WEATHER"). */
  readonly sourceLabel: string | null;
  readonly synthetic: boolean | null;
};

type StoredEvaluation = {
  readonly evaluation: {
    readonly assetId: string;
    readonly signal: string;
    readonly observedAt: string;
    readonly outcome: "NORMAL" | "WATCH" | "CANDIDATE_RISK" | "INSUFFICIENT_DATA";
    readonly instantOutcome: "NORMAL" | "WATCH" | "CANDIDATE_RISK" | "INSUFFICIENT_DATA";
    readonly reasonCodes: readonly string[];
    readonly ruleId: string;
    readonly ruleVersion: string;
    readonly baseline?: { readonly status: string; readonly operatingMode: string };
    readonly metrics: {
      readonly vibrationZ?: number;
      readonly currentDeviationPercent?: number;
      readonly outdoorTemperatureDegF?: number;
      readonly zoneTemperatureSlopeDegCPerHour?: number;
    };
    readonly persistence?: { readonly qualifyingEvaluations: number; readonly required: number };
  };
};

type EvaluationHistory = {
  readonly instants: readonly {
    readonly at: string;
    readonly outcome: string;
    readonly qualifying: number;
    readonly required: number;
  }[];
};

const STATUS_FROM_OUTCOME: Record<string, SensorStatus> = {
  NORMAL: "NORMAL",
  WATCH: "WARNING",
  CANDIDATE_RISK: "CRITICAL",
  INSUFFICIENT_DATA: "LEARNING",
};

const NO_DATA_AFTER_SECONDS = 45;

/** Latest observation per asset and signal inside a window. */
function latestPer(obs: readonly CanonicalObservation[]): Map<string, CanonicalObservation> {
  const out = new Map<string, CanonicalObservation>();
  for (const o of obs) {
    const k = `${o.assetId}|${o.signal}`;
    const cur = out.get(k);
    if (cur === undefined || Date.parse(o.observedAt) >= Date.parse(cur.observedAt)) out.set(k, o);
  }
  return out;
}

const trustNote = (o: CanonicalObservation): string | null => {
  const q = o.quality;
  const reasons = [
    ...(q.authVerified ? [] : ["not authenticated"]),
    ...(q.stale ? ["stale"] : []),
    ...(q.outOfRange ? ["out of range"] : []),
    ...(q.deviceHealthy ? [] : ["device not healthy"]),
    ...(q.confidence < 0.5 ? ["low confidence"] : []),
  ];
  return reasons.length === 0 ? null : reasons.join(", ");
};

export function createSimulationViews(deps: ViewDeps) {
  const { facility } = deps;
  const org = facility.organizationId;
  const fac = facility.facilityId;
  const assetName = (id: string) => facility.assets.find((a) => a.assetId === id)?.name ?? id;
  const primary = facility.assets.find((a) => a.kind === "COOLING_PRIMARY")?.assetId ?? "";
  const profileLabel = (deviceId: string) =>
    facility.devices.find((d) => d.deviceId === deviceId)?.displayName ?? deviceId;

  async function evaluations(): Promise<{
    latest: Map<string, StoredEvaluation>;
    history: EvaluationHistory["instants"];
  }> {
    const docs = await deps.store.list<StoredEvaluation>("ruleEvaluations", org, {
      where: { facilityId: fac, kind: "LATEST" },
    });
    const latest = new Map(docs.map((d) => [`${d.evaluation.assetId}|${d.evaluation.signal}`, d]));
    const h = await deps.store.get<EvaluationHistory>("ruleEvaluations", org, `HISTORY.${fac}`);
    return { latest, history: h?.instants ?? [] };
  }

  async function sensors(weatherLabel: { synthetic: boolean; live: boolean; label: string }) {
    const now = deps.clock.nowMs();
    const near = await deps.observations.listForWindow({
      organizationId: org,
      facilityId: fac,
      assetIds: facility.assets.filter((a) => a.kind !== "WEATHER").map((a) => a.assetId),
      fromIso: new Date(now - 180_000).toISOString(),
      toIso: new Date(now + 60_000).toISOString(),
    });
    const outdoorAsset = facility.assets.find((a) => a.kind === "WEATHER")?.assetId ?? "";
    const outdoor = await deps.observations.listForWindow({
      organizationId: org,
      facilityId: fac,
      assetIds: [outdoorAsset],
      fromIso: new Date(now - 6 * 3_600_000).toISOString(),
      toIso: new Date(now + 60_000).toISOString(),
    });
    const latest = latestPer([...near, ...outdoor]);
    const { latest: evals } = await evaluations();
    return facility.sensors.map((s): SensorView => {
      const o = latest.get(`${s.assetId}|${s.signal}`);
      const base = {
        sensorId: s.sensorId,
        name: s.name,
        assetId: s.assetId,
        assetName: assetName(s.assetId),
        signal: s.signal,
        group: s.group,
        unit: s.displayUnit,
      };
      if (o === undefined) {
        return {
          ...base,
          value: null,
          observedAt: null,
          ageSeconds: null,
          confidence: null,
          trusted: null,
          trustNote: null,
          status: "NO_DATA",
          sourceType: null,
          sourceAdapter: null,
          deviceId: null,
          sourceLabel: null,
          synthetic: null,
        };
      }
      const ageSeconds = Math.max(0, Math.round((now - Date.parse(o.observedAt)) / 1000));
      const note = trustNote(o);
      const trusted = note === null;
      const e = evals.get(`${s.assetId}|${s.signal}`);
      let status: SensorStatus;
      if (s.group !== "weather" && ageSeconds > NO_DATA_AFTER_SECONDS) status = "NO_DATA";
      else if (!trusted) status = "UNTRUSTED";
      else if (e !== undefined) status = STATUS_FROM_OUTCOME[e.evaluation.outcome] ?? "NORMAL";
      else status = "NORMAL";
      const isWeather = o.sourceType === "WEATHER_API" || s.group === "weather";
      return {
        ...base,
        value: o.value,
        observedAt: o.observedAt,
        ageSeconds,
        confidence: Math.round(o.quality.confidence * 100) / 100,
        trusted,
        trustNote: note,
        status,
        sourceType: o.sourceType,
        sourceAdapter: o.sourceAdapter,
        deviceId: o.deviceId,
        sourceLabel: isWeather ? weatherLabel.label : profileLabel(o.deviceId),
        synthetic: o.sourceType === "SIMULATOR",
      };
    });
  }

  async function baselineStatus() {
    const active = await deps.baselines.listActive(org, fac);
    const wanted: { signal: CanonicalSignal; label: string }[] = [
      { signal: "vibration_rms", label: "Vibration" },
      { signal: "current", label: "Current" },
      { signal: "temperature", label: "Zone temperature" },
    ];
    const signals = wanted.map((w) => {
      const list = active.filter(
        (b) =>
          b.key.signal === w.signal &&
          (w.signal === "temperature" ? b.key.assetId !== primary : b.key.assetId === primary),
      );
      const ready = list.length > 0 && list.every((b) => b.status === "READY");
      const learning = list.find((b) => b.status === "LEARNING");
      return {
        signal: w.signal,
        label: w.label,
        status:
          list.length === 0
            ? "NOT_STARTED"
            : ready
              ? "READY"
              : (learning?.status ?? list[0]?.status ?? "NOT_STARTED"),
        samples: list.reduce((n, b) => n + b.observationCount, 0),
      };
    });
    const primaryReady = signals
      .filter((s) => s.signal === "vibration_rms" || s.signal === "current")
      .every((s) => s.status === "READY");
    return { ready: primaryReady, signals };
  }

  return {
    sensors,
    baselineStatus,
    evaluations,

    async devices(profileVersions: Map<string, number>) {
      const registered = await deps.registry.listForFacility(org, fac);
      return facility.devices.map((d) => {
        const r = registered.find((x) => x.deviceId === d.deviceId);
        return {
          deviceId: d.deviceId,
          displayName: d.displayName,
          profileId: d.profileId,
          profileVersion: profileVersions.get(d.profileId) ?? 1,
          group: d.group,
          health: r?.health ?? "UNKNOWN",
          lastSeenAt: r?.lastSeenAt ?? null,
          registered: r !== undefined,
        };
      });
    },

    /** What the deterministic rule concluded, copied from storage (never recomputed here). */
    async rule(thresholds: Readonly<Record<string, number>>, weather: { source: string }) {
      const { latest, history } = await evaluations();
      // The newest sample instant; when its signals arrived in separate events, the complete
      // conclusion (not the partial one that saw only one signal) is what the rule concluded.
      const primaryEvals = [...latest.values()]
        .filter((e) => e.evaluation.assetId === primary)
        .sort(
          (a, b) =>
            Date.parse(b.evaluation.observedAt) - Date.parse(a.evaluation.observedAt) ||
            Number(a.evaluation.instantOutcome === "INSUFFICIENT_DATA") -
              Number(b.evaluation.instantOutcome === "INSUFFICIENT_DATA"),
        );
      const newest = primaryEvals[0]?.evaluation;
      const m = newest?.metrics ?? {};
      // Whether a signal was abnormal is what the rule recorded for THAT signal at the newest instant.
      const signalMet = (signal: string): boolean | null => {
        const e = latest.get(`${primary}|${signal}`)?.evaluation;
        if (e === undefined || e.observedAt !== newest?.observedAt) return null;
        if (e.outcome === "INSUFFICIENT_DATA") return null;
        return e.outcome === "WATCH" || e.outcome === "CANDIDATE_RISK";
      };
      const exceeds = (value: number | undefined, threshold: number | undefined): boolean | null =>
        value === undefined || threshold === undefined ? null : value >= threshold;
      const zoneMetric = [...latest.values()].find(
        (e) => e.evaluation.signal === "temperature" && e.evaluation.assetId !== primary,
      )?.evaluation.metrics.zoneTemperatureSlopeDegCPerHour;
      const outdoorMetric = [...latest.values()].find(
        (e) => e.evaluation.signal === "outdoor_temperature",
      )?.evaluation.metrics.outdoorTemperatureDegF;
      const num = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100) / 100);
      return {
        ruleId: newest?.ruleId ?? null,
        ruleVersion: newest?.ruleVersion ?? null,
        evaluatedAt: newest?.observedAt ?? null,
        outcome: newest?.instantOutcome ?? null,
        persistence: newest?.persistence ?? null,
        conditions: [
          {
            id: "VIBRATION",
            label: "Vibration deviation from baseline",
            role: "REQUIRED",
            value: num(m.vibrationZ),
            threshold: thresholds["rule.vibrationZ"] ?? null,
            operator: ">=",
            unit: "standard deviations",
            met: signalMet("vibration_rms"),
            source: "SENSOR",
          },
          {
            id: "CURRENT",
            label: "Current deviation from baseline",
            role: "REQUIRED",
            value: num(m.currentDeviationPercent),
            threshold: thresholds["rule.currentDeviationPercent"] ?? null,
            operator: ">= +",
            unit: "%",
            met: signalMet("current"),
            source: "SENSOR",
          },
          {
            id: "HEAT",
            label: "Outdoor heat",
            role: "CONTEXT (heat or rising zone temperature)",
            value: num(outdoorMetric ?? m.outdoorTemperatureDegF),
            threshold: thresholds["rule.outdoorTemperatureDegF"] ?? null,
            operator: ">=",
            unit: "degF",
            met: exceeds(
              outdoorMetric ?? m.outdoorTemperatureDegF,
              thresholds["rule.outdoorTemperatureDegF"],
            ),
            source: weather.source,
          },
          {
            id: "ZONE_RISING",
            label: "Zone temperature trend",
            role: "CONTEXT (heat or rising zone temperature)",
            value: num(zoneMetric ?? m.zoneTemperatureSlopeDegCPerHour),
            threshold: thresholds["rule.zoneSlopeDegCPerHour"] ?? null,
            operator: ">",
            unit: "degC per hour",
            met: (() => {
              const v = zoneMetric ?? m.zoneTemperatureSlopeDegCPerHour;
              const t = thresholds["rule.zoneSlopeDegCPerHour"];
              return v === undefined || t === undefined ? null : v > t;
            })(),
            source: "SENSOR",
          },
        ],
        history: history.slice(-30),
      };
    },

    async timeline(auditBase: number, limit = 80) {
      const entries = (await deps.audit.listAfter(org, auditBase, 1000)).filter(
        (e) => e.facilityId === fac,
      );
      const { history } = await evaluations();
      const items = [...entries.map(auditItem), ...detectionItems(history)];
      items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.order ?? 0) - (b.order ?? 0));
      return items.slice(-limit);
    },

    async series(seconds: number) {
      const now = deps.clock.nowMs();
      const from = now - seconds * 1000;
      const ids = facility.assets.map((a) => a.assetId);
      const obs = await deps.observations.listForWindow({
        organizationId: org,
        facilityId: fac,
        assetIds: ids,
        fromIso: new Date(from).toISOString(),
        toIso: new Date(now + 60_000).toISOString(),
      });
      const pick = (assetId: string, signal: CanonicalSignal) =>
        obs
          .filter((o) => o.assetId === assetId && o.signal === signal)
          .map((o) => ({
            t: Date.parse(o.observedAt),
            v: typeof o.value === "boolean" ? (o.value ? 1 : 0) : o.value,
            trusted: trustNote(o) === null,
          }));
      const zone = facility.assets.find((a) => a.kind === "ZONE")?.assetId ?? "";
      const backup = facility.assets.find((a) => a.kind === "COOLING_BACKUP")?.assetId ?? "";
      const outdoor = facility.assets.find((a) => a.kind === "WEATHER")?.assetId ?? "";
      const baselines = await deps.baselines.listActive(org, fac);
      const mean = (signal: CanonicalSignal, asset: string) =>
        baselines.find(
          (b) => b.key.signal === signal && b.key.assetId === asset && b.status === "READY",
        )?.mean ?? null;
      return {
        fromMs: from,
        toMs: now,
        series: {
          vibration: {
            label: "Vibration",
            unit: "m/s2",
            baseline: mean("vibration_rms", primary),
            points: pick(primary, "vibration_rms"),
          },
          current: {
            label: "Equipment current",
            unit: "A",
            baseline: mean("current", primary),
            points: pick(primary, "current"),
          },
          zoneTemperature: {
            label: "Zone temperature",
            unit: "degC",
            baseline: mean("temperature", zone),
            points: pick(zone, "temperature"),
          },
          outdoorTemperature: {
            label: "Outdoor temperature",
            unit: "degC",
            baseline: null,
            points: pick(outdoor, "outdoor_temperature"),
          },
          backupRunning: {
            label: "Backup unit running",
            unit: "state",
            baseline: null,
            points: pick(backup, "equipment_running"),
          },
        },
      };
    },

    async traces(profileId: string, limit = 6): Promise<readonly AdapterTrace[]> {
      const list = await deps.store.list<AdapterTrace>("adapterTraces", org, {
        where: { facilityId: fac },
        limit: 300,
      });
      return list
        .filter((t) => t.profileId === profileId)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        .slice(0, limit);
    },
  };
}

export type SimulationViews = ReturnType<typeof createSimulationViews>;

export type TimelineItem = {
  readonly at: string;
  readonly kind: string;
  readonly tone: "info" | "good" | "warn" | "bad";
  readonly title: string;
  readonly detail?: string;
  readonly actorId?: string;
  readonly caseId?: string;
  readonly order?: number;
};

const det = (e: AuditEntry, k: string): string | undefined => {
  const v = e.details?.[k];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : undefined;
};
const list = (e: AuditEntry, k: string): string[] => {
  const v = e.details?.[k];
  return Array.isArray(v) ? (v as string[]) : [];
};

/** Fixed wording per audit action: the timeline says what the record says and nothing more. */
export function auditItem(e: AuditEntry): TimelineItem {
  const base = {
    at: e.at,
    actorId: e.actorId,
    ...(e.caseId !== undefined && { caseId: e.caseId }),
    order: e.sequence,
  };
  const alertKind = det(e, "kind");
  switch (e.action) {
    case "SIMULATION_STARTED":
      return { ...base, kind: "SIMULATION", tone: "info", title: "Simulation started" };
    case "SIMULATION_SCENARIO_APPLIED":
      return {
        ...base,
        kind: "SIMULATION",
        tone: "info",
        title: `Scenario applied: ${det(e, "scenario") ?? ""}`,
        detail: list(e, "changes").join("; "),
      };
    case "SIMULATION_STATE_CHANGED":
      return {
        ...base,
        kind: "SIMULATION",
        tone: "info",
        title: "Simulated world changed by hand",
        detail: list(e, "changes").join("; "),
      };
    case "SIMULATION_RESET":
      return {
        ...base,
        kind: "SIMULATION",
        tone: "warn",
        title: "Simulation reset to a clean state",
      };
    case "SIMULATION_POLICY_PUBLISHED":
      return {
        ...base,
        kind: "POLICY",
        tone: "info",
        title: `Demo policy ${e.targetId} published`,
        detail: `${det(e, "reason") ?? ""} (${list(e, "changes").join("; ")})`,
      };
    case "SIMULATION_POLICY_ACTIVATED":
      return {
        ...base,
        kind: "POLICY",
        tone: "info",
        title: `Demo policy ${e.targetId} activated`,
      };
    case "ADAPTER_MAPPING_PUBLISHED":
      return {
        ...base,
        kind: "ADAPTER",
        tone: "info",
        title: `Adapter mapping ${e.targetId} published`,
        detail: det(e, "reason") ?? "",
      };
    case "ADAPTER_MAPPING_ACTIVATED":
      return {
        ...base,
        kind: "ADAPTER",
        tone: "info",
        title: `Adapter mapping ${e.targetId} activated`,
      };
    case "WEATHER_STATUS_CHANGED":
      return {
        ...base,
        kind: "WEATHER",
        tone: e.afterState === "LIVE" || e.afterState === "SIMULATED" ? "info" : "warn",
        title: `Weather: ${e.afterState ?? ""}`,
      };
    case "CASE_CREATED":
      return {
        ...base,
        kind: "CASE",
        tone: "bad",
        title: `Risk detected: case opened (${det(e, "severity") ?? ""})`,
      };
    case "DETECTION_RECORDED":
      return {
        ...base,
        kind: "CASE",
        tone: "warn",
        title: "Condition continues (detection recorded on the case)",
      };
    case "ALERT_REQUESTED":
      return { ...base, kind: "ALERT", tone: "info", title: `${alertLabel(alertKind)} requested` };
    case "ALERT_SENT":
      return {
        ...base,
        kind: "NOTIFICATION",
        tone: "good",
        title: `${alertLabel(alertKind)} sent`,
        detail: `to ${det(e, "recipient") ?? ""}`,
      };
    case "ALERT_FAILED":
      return {
        ...base,
        kind: "NOTIFICATION",
        tone: "bad",
        title: `${alertLabel(alertKind)} delivery failed (${det(e, "code") ?? ""})`,
        detail: det(e, "exhausted") === "true" ? "No more attempts" : "Will retry",
      };
    case "RISK_ALERTED":
      return {
        ...base,
        kind: "CASE",
        tone: "warn",
        title: "Risk alerted: waiting for acknowledgement",
      };
    case "RISK_ACKNOWLEDGED":
      return { ...base, kind: "HUMAN", tone: "good", title: "Acknowledged by a person" };
    case "RISK_ESCALATED":
      return {
        ...base,
        kind: "CASE",
        tone: "bad",
        title: "Not acknowledged in time: escalated",
        detail: det(e, "reason") ?? "",
      };
    case "ACTION_ASSIGNED":
      return { ...base, kind: "HUMAN", tone: "info", title: "Approved action assigned" };
    case "ACTION_ACKNOWLEDGED":
      return { ...base, kind: "HUMAN", tone: "info", title: "Assigned action acknowledged" };
    case "ACTION_REPORTED":
      return {
        ...base,
        kind: "HUMAN",
        tone: "warn",
        title: "Action reported complete (not yet verified)",
      };
    case "VERIFICATION_STARTED":
      return {
        ...base,
        kind: "VERIFICATION",
        tone: "info",
        title: "Verification started: watching the sensors",
      };
    case "VERIFICATION_COMPLETED": {
      const r = e.afterState ?? det(e, "result") ?? "";
      return {
        ...base,
        kind: "VERIFICATION",
        tone: r === "VERIFIED" ? "good" : "bad",
        title: `Verification result: ${r.replace(/_/g, " ")}`,
        detail: `policy ${det(e, "policyVersion") ?? ""}`,
      };
    }
    case "FOLLOW_UP_REQUESTED":
      return {
        ...base,
        kind: "NOTIFICATION",
        tone: "warn",
        title: `Follow-up requested: ${(det(e, "trigger") ?? "").replace(/_/g, " ").toLowerCase()}`,
        detail: det(e, "why") ?? "",
      };
    case "FOLLOW_UP_SUPPRESSED":
      return {
        ...base,
        kind: "NOTIFICATION",
        tone: "info",
        title: `Follow-up held back: ${(det(e, "reason") ?? "").toLowerCase().replace(/_/g, " ")}`,
      };
    case "RECURRENCE_DETECTED":
      return {
        ...base,
        kind: "CASE",
        tone: "bad",
        title: "Recurrence: the verified risk returned",
      };
    case "CASE_REOPENED":
      return {
        ...base,
        kind: "CASE",
        tone: "bad",
        title: `Same case reopened (recurrence ${det(e, "recurrenceCount") ?? ""})`,
      };
    case "INTERVENTION_RECOMMENDED":
      return {
        ...base,
        kind: "VERIFICATION",
        tone: "warn",
        title: "Risk-engineer intervention recommendation updated",
        detail: det(e, "level") ?? "",
      };
    case "EVIDENCE_PACKAGE_CREATED":
      return {
        ...base,
        kind: "EVIDENCE",
        tone: "info",
        title: "Evidence package created (simulation data)",
      };
    case "SHARING_AGREEMENT_CREATED":
      return {
        ...base,
        kind: "EVIDENCE",
        tone: "info",
        title: "Sharing agreement created by the customer",
      };
    case "SHARING_AGREEMENT_REVOKED":
      return { ...base, kind: "EVIDENCE", tone: "warn", title: "Sharing agreement revoked" };
    case "EVIDENCE_SHARED":
      return {
        ...base,
        kind: "EVIDENCE",
        tone: "info",
        title: "Evidence made available under consent",
      };
    default:
      return {
        ...base,
        kind: "SYSTEM",
        tone: "info",
        title: e.action.replace(/_/g, " ").toLowerCase(),
      };
  }
}

const alertLabel = (kind: string | undefined) =>
  kind === "FOLLOW_UP"
    ? "Follow-up email"
    : kind === "ESCALATION"
      ? "Escalation email"
      : "Alert email";

/** Detection progress derived from stored evaluations: when the rule's view of the world changed. */
function detectionItems(
  history: readonly { at: string; outcome: string; qualifying: number; required: number }[],
): TimelineItem[] {
  const out: TimelineItem[] = [];
  let lastOutcome: string | undefined;
  let lastQualifying = -1;
  for (const i of history) {
    if (i.outcome !== lastOutcome || i.qualifying !== lastQualifying) {
      if (i.outcome === "WATCH") {
        out.push({
          at: i.at,
          kind: "DETECTION",
          tone: "warn",
          title: "Watch: one signal is abnormal",
        });
      } else if (i.outcome === "CANDIDATE_RISK") {
        out.push({
          at: i.at,
          kind: "DETECTION",
          tone: "bad",
          title: `Compound condition present: persistence ${i.qualifying}/${i.required}`,
        });
      } else if (
        i.outcome === "NORMAL" &&
        lastOutcome !== undefined &&
        lastOutcome !== "NORMAL" &&
        lastOutcome !== "INSUFFICIENT_DATA"
      ) {
        out.push({
          at: i.at,
          kind: "DETECTION",
          tone: "good",
          title: "Sensor values back to normal",
        });
      } else if (
        i.outcome === "INSUFFICIENT_DATA" &&
        lastOutcome !== undefined &&
        lastOutcome !== "INSUFFICIENT_DATA"
      ) {
        out.push({
          at: i.at,
          kind: "DETECTION",
          tone: "warn",
          title: "Insufficient trusted data to evaluate the rule",
        });
      }
      lastOutcome = i.outcome;
      lastQualifying = i.qualifying;
    }
  }
  return out;
}

export type CaseSummaryForView = Pick<
  RiskImprovementCase,
  "caseId" | "title" | "severity" | "state" | "recurrenceCount" | "facilityId"
>;
