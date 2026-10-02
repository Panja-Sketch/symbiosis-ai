import { CANONICAL_SIGNALS } from "@symbiosis/contracts";
import type { AssetMapping, CanonicalSignal } from "@symbiosis/contracts";

/**
 * The simulated facility (S10, D-091): which assets exist, which synthetic vendor devices report
 * for them, and which sensors the evaluator sees. It is configuration (config/simulation), read at
 * startup. Names here are for people; ids stay secondary in the UI.
 */
export const SIMULATION_FACILITY_SCHEMA = "simulation-facility.v1" as const;

export const SENSOR_GROUPS = ["hvac", "vibration", "meter", "weather"] as const;
export type SensorGroup = (typeof SENSOR_GROUPS)[number];

export type FacilityAsset = {
  readonly assetId: string;
  readonly name: string;
  readonly kind: "ZONE" | "COOLING_PRIMARY" | "COOLING_BACKUP" | "WEATHER";
};

export type FacilityDevice = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly profileId: string;
  readonly displayName: string;
  /** The sensor group whose health, staleness and dropout controls apply to this device. */
  readonly group: Exclude<SensorGroup, "weather">;
  readonly assetId: string;
  readonly assetMapping?: AssetMapping;
  readonly expectedSignals: readonly CanonicalSignal[];
};

export type FacilitySensor = {
  readonly sensorId: string;
  readonly name: string;
  readonly assetId: string;
  readonly signal: CanonicalSignal;
  readonly displayUnit: string;
  readonly group: SensorGroup;
};

export type FacilityModel = {
  readonly schema: typeof SIMULATION_FACILITY_SCHEMA;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly name: string;
  readonly description: string;
  readonly location: {
    readonly label: string;
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly weatherDeviceId: string;
  readonly assets: readonly FacilityAsset[];
  readonly devices: readonly FacilityDevice[];
  readonly sensors: readonly FacilitySensor[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const str = (v: unknown, max = 120): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function parseFacilityModel(value: unknown): FacilityModel {
  const fail = (why: string): never => {
    throw new Error(`invalid simulation facility: ${why}`);
  };
  if (!isRecord(value) || value.schema !== SIMULATION_FACILITY_SCHEMA) return fail("schema");
  for (const k of ["organizationId", "facilityId", "weatherDeviceId"] as const) {
    if (typeof value[k] !== "string" || !ID.test(value[k] as string)) fail(k);
  }
  if (!str(value.name) || !str(value.description, 500)) fail("name/description");
  const loc = value.location;
  if (
    !isRecord(loc) ||
    !str(loc.label) ||
    typeof loc.latitude !== "number" ||
    typeof loc.longitude !== "number" ||
    Math.abs(loc.latitude) > 90 ||
    Math.abs(loc.longitude) > 180
  ) {
    fail("location");
  }
  const list = (k: string): Record<string, unknown>[] => {
    const v = value[k];
    if (!Array.isArray(v) || v.length === 0 || !v.every(isRecord)) fail(k);
    return v as Record<string, unknown>[];
  };
  const assets = list("assets");
  const devices = list("devices");
  const sensors = list("sensors");
  const assetIds = new Set<string>();
  for (const a of assets) {
    if (typeof a.assetId !== "string" || !ID.test(a.assetId) || assetIds.has(a.assetId))
      fail("asset id");
    if (
      !str(a.name) ||
      !["ZONE", "COOLING_PRIMARY", "COOLING_BACKUP", "WEATHER"].includes(a.kind as string)
    ) {
      fail("asset");
    }
    assetIds.add(a.assetId as string);
  }
  const deviceIds = new Set<string>();
  for (const d of devices) {
    if (
      typeof d.deviceId !== "string" ||
      deviceIds.has(d.deviceId) ||
      !str(d.profileId) ||
      !str(d.keyId)
    ) {
      fail("device");
    }
    deviceIds.add(d.deviceId as string);
    if (!assetIds.has(d.assetId as string)) fail(`device ${String(d.deviceId)} asset`);
    if (!["hvac", "vibration", "meter"].includes(d.group as string)) fail("device group");
    const sigs = d.expectedSignals;
    if (
      !Array.isArray(sigs) ||
      sigs.length === 0 ||
      !sigs.every((s) => (CANONICAL_SIGNALS as readonly unknown[]).includes(s))
    ) {
      fail("device signals");
    }
  }
  for (const s of sensors) {
    if (!str(s.sensorId) || !str(s.name) || !assetIds.has(s.assetId as string)) fail("sensor");
    if (!(CANONICAL_SIGNALS as readonly unknown[]).includes(s.signal)) fail("sensor signal");
    if (!(SENSOR_GROUPS as readonly unknown[]).includes(s.group)) fail("sensor group");
  }
  if (!deviceIds.has(value.weatherDeviceId as string) && !str(value.weatherDeviceId))
    fail("weather device");
  return value as unknown as FacilityModel;
}

export const assetName = (m: FacilityModel, assetId: string): string =>
  m.assets.find((a) => a.assetId === assetId)?.name ?? assetId;

/** Every device id the simulation may sign for (the weather feed is not one: nothing signs for it). */
export const simulationDeviceIds = (m: FacilityModel): readonly string[] =>
  m.devices.map((d) => d.deviceId);

/** True for exactly the one simulation tenant and facility (the only boundary simulation may touch). */
export const isSimulationScope = (m: FacilityModel, organizationId: string, facilityId: string) =>
  m.organizationId === organizationId && m.facilityId === facilityId;
