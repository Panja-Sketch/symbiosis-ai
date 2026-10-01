import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Baseline,
  CanonicalObservation,
  CanonicalSignal,
  MitigationAction,
  ObservationQuality,
  RiskEvent,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import { parseBaselineConfig } from "@symbiosis/baselines";
import { parseVerificationPolicy } from "./policy";
import type { VerificationPolicy } from "./policy";
import type { DeviceFact, VerificationInput } from "./engine";

export const ORG = "ORG-SIM-001";
export const FAC = "FAC-SIM-001";
export const PRIMARY = "AST-SIM-FAN-A";
export const BACKUP = "AST-SIM-FAN-B";
export const ZONE = "AST-SIM-ZONE-1";
export const DEVICE = "DEV-SIM-001";
export const T0 = Date.parse("2026-10-01T01:00:00.000Z");

const root = join(import.meta.dirname, "..", "..", "..");
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

export const POLICY: VerificationPolicy = parseVerificationPolicy(
  readJson("config", "verification-policy", "cooling-electrical.v1.json"),
);
export const BASELINE_CONFIG = parseBaselineConfig(
  readJson("config", "rules", "baselines.v1.json"),
);

export const iso = (ms: number) => new Date(ms).toISOString();

export const HEALTHY_QUALITY: ObservationQuality = {
  confidence: 1,
  stale: false,
  outOfRange: false,
  deviceHealthy: true,
  authVerified: true,
};

const UNITS: Record<string, string> = {
  vibration_rms: "m/s2",
  current: "A",
  load_percent: "%",
  equipment_running: "bool",
  temperature: "degC",
};

export function observation(input: {
  signal: CanonicalSignal;
  value: number | boolean;
  at: number;
  assetId?: string;
  organizationId?: string;
  facilityId?: string;
  deviceId?: string;
  quality?: Partial<ObservationQuality>;
}): CanonicalObservation {
  const assetId = input.assetId ?? PRIMARY;
  const observedAt = iso(input.at);
  return {
    observationId: `OBS-${input.deviceId ?? DEVICE}-${input.signal}-${assetId}-${observedAt}`,
    organizationId: input.organizationId ?? ORG,
    facilityId: input.facilityId ?? FAC,
    assetId,
    deviceId: input.deviceId ?? DEVICE,
    signal: input.signal,
    value: input.value,
    unit: UNITS[input.signal] ?? "",
    observedAt,
    receivedAt: observedAt,
    sourceType: "SIMULATOR",
    sourceAdapter: "test",
    quality: { ...HEALTHY_QUALITY, ...input.quality },
  };
}

export function baseline(
  signal: "vibration_rms" | "current",
  mean: number,
  over: Partial<Baseline> & { mode?: string } = {},
): Baseline {
  const mode = over.mode ?? "HIGH_LOAD";
  const { mode: _ignored, ...rest } = over;
  void _ignored;
  const key = {
    organizationId: ORG,
    facilityId: FAC,
    assetId: PRIMARY,
    signal,
    operatingMode: mode,
  };
  return {
    baselineId: `BSL:${ORG}|${FAC}|${PRIMARY}|${signal}|${mode}:v1`,
    key,
    version: 1,
    status: "READY",
    configVersion: "baselines.v1",
    observationCount: 25,
    mean,
    m2: 0.0001,
    min: mean,
    max: mean,
    learningStartedAt: iso(T0 - 3_600_000),
    lastObservationAt: iso(T0 - 3_400_000),
    readyAt: iso(T0 - 3_480_000),
    ...rest,
  };
}

export const VIB_MEAN = 0.18;
export const CUR_MEAN = 0.312;

export type Knobs = {
  vib?: (i: number) => number | undefined;
  cur?: (i: number) => number | undefined;
  load?: (i: number) => number | undefined;
  backup?: (i: number) => boolean | undefined;
  zone?: (i: number) => number | undefined;
  count?: number;
  stepSeconds?: number;
  quality?: (signal: string, i: number) => Partial<ObservationQuality> | undefined;
  actionLibraryIds?: string[];
  devices?: DeviceFact[];
  extraObservations?: CanonicalObservation[];
  snapshotBaselines?: Baseline[];
  activeBaselines?: Baseline[];
  policy?: VerificationPolicy;
  nowMs?: number;
};

export const healthyDevice: DeviceFact = {
  deviceId: DEVICE,
  organizationId: ORG,
  facilityId: FAC,
  status: "ACTIVE",
  health: "HEALTHY",
  assetIds: [PRIMARY, BACKUP, ZONE, "AST-SIM-OUTDOOR"],
};

/** Healthy, fully sampled, improved post-action data unless a knob says otherwise. */
export function makeInput(knobs: Knobs = {}): VerificationInput {
  const count = knobs.count ?? 25;
  const step = (knobs.stepSeconds ?? 5) * 1000;
  const observations: CanonicalObservation[] = [];
  const add = (
    signal: CanonicalSignal,
    fn: ((i: number) => number | boolean | undefined) | undefined,
    assetId: string,
  ) => {
    if (fn === undefined) return;
    for (let i = 0; i < count; i++) {
      const value = fn(i);
      if (value === undefined) continue;
      const quality = knobs.quality?.(signal, i);
      observations.push(
        observation({
          signal,
          value,
          at: T0 + i * step,
          assetId,
          ...(quality !== undefined && { quality }),
        }),
      );
    }
  };
  add("vibration_rms", knobs.vib ?? ((i) => VIB_MEAN + ((i % 5) - 2) * 0.002), PRIMARY);
  add("current", knobs.cur ?? (() => CUR_MEAN), PRIMARY);
  add("load_percent", knobs.load ?? (() => 100), PRIMARY);
  add("equipment_running", knobs.backup, BACKUP);
  add("temperature", knobs.zone, ZONE);
  observations.push(...(knobs.extraObservations ?? []));

  const actionLibraryIds = knobs.actionLibraryIds ?? ["ACT-COOLING-INSPECT-PRIMARY"];
  const actions: MitigationAction[] = actionLibraryIds.map((id, n) => ({
    actionId: `ACT-${n + 1}`,
    organizationId: ORG,
    caseId: "CASE-1",
    eventId: "RE-1",
    actionLibraryId: id,
    assignedTo: "USR-OPERATOR-001",
    reportedBy: "USR-OPERATOR-001",
    reportedAt: iso(T0),
    status: "REPORTED_COMPLETE",
  }));
  const caseRecord: RiskImprovementCase = {
    caseId: "CASE-1",
    organizationId: ORG,
    facilityId: FAC,
    assetIds: [PRIMARY, "AST-SIM-OUTDOOR"],
    origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
    hazardType: "COOLING_ELECTRICAL_DETERIORATION",
    title: "t",
    severity: "MODERATE",
    baselineSnapshotId: "BSNAP-1",
    activeRiskEventId: "RE-1",
    state: "VERIFYING",
    recurrenceCount: 0,
    sharingState: "NOT_SHARED",
    createdAt: iso(T0 - 600_000),
    updatedAt: iso(T0),
  };
  const event: RiskEvent = {
    eventId: "RE-1",
    caseId: "CASE-1",
    organizationId: ORG,
    facilityId: FAC,
    assetIds: caseRecord.assetIds,
    state: "VERIFYING",
    detectedAt: iso(T0 - 600_000),
    updatedAt: iso(T0),
  };
  const policy = knobs.policy ?? POLICY;
  const end = T0 + policy.postActionWindow.durationSeconds * 1000;
  return {
    verificationId: "VER-1",
    policy,
    baselineConfig: BASELINE_CONFIG,
    caseRecord,
    event,
    actions,
    actionReportedAt: iso(T0),
    window: { start: iso(T0), end: iso(end) },
    now: iso(knobs.nowMs ?? end),
    observations,
    snapshotBaselines: knobs.snapshotBaselines ?? [
      baseline("vibration_rms", VIB_MEAN),
      baseline("current", CUR_MEAN),
    ],
    activeBaselines: knobs.activeBaselines ?? [],
    devices: knobs.devices ?? [healthyDevice],
    auditEvidenceIds: ["AUD-000001"],
  };
}
