import { noise, round } from "./state";
import type { PhysicalValues, SimulatedSensorGroup } from "./state";

/**
 * Synthetic VENDOR payloads (S10, D-088/D-091). Each function writes the shape one made-up vendor
 * would send, from the simulated physical world. These are the SOURCE side of the integration
 * boundary: they know the vendors' field names and units, and nothing about canonical signals, risk
 * or cases. The versioned adapter mapping on the platform side is what turns them into canonical
 * observations. All numbers are deterministic (a seeded hash), never random.
 */
const G = 9.80665;

type Ctx = {
  readonly seed: string;
  readonly values: PhysicalValues;
  /** The sampling instant on the shared 5-second grid. */
  readonly instantMs: number;
  /** What the device stamps on the sample (the instant minus any simulated staleness). */
  readonly stampMs: number;
};

/** Small, deterministic measurement noise; the zone temperature is deliberately noise-free (a stable setpoint). */
const jitter = (c: Ctx, field: string, amplitude: number) =>
  noise(c.seed, field, c.instantMs) * amplitude;

export type VendorPayloadBuilder = (c: Ctx) => Record<string, unknown>;

/** Vibration Sensor Gateway: RMS acceleration in g, epoch-millisecond timestamp. */
const vibrationGateway: VendorPayloadBuilder = (c) => {
  const ms2 = Math.max(0, c.values.vibrationRmsMs2 * (1 + jitter(c, "vib", 0.02)));
  return {
    sensor: "VG-7",
    channel: "motor-DE",
    sampledAtMs: c.stampMs,
    rms: { value: round(ms2 / G, 6), unit: "g" },
  };
};

/** Electrical Meter Gateway: milliamps and load as a fraction, epoch-second timestamp, contactor state. */
const electricalMeter: VendorPayloadBuilder = (c) => {
  const amps = Math.max(0, c.values.currentA * (1 + jitter(c, "cur", 0.004)));
  return {
    meterId: "EM-2",
    t: Math.floor(c.stampMs / 1000),
    totals: {
      current: { v: Math.round(amps * 1000), u: "mA" },
      load: { v: round(c.values.loadPercent / 100, 4), u: "fraction" },
    },
    contactor: c.values.primaryRunning ? "CLOSED" : "OPEN",
  };
};

/** HVAC Controller: nested measurements with their own units (Fahrenheit, humidity as a fraction). */
const hvacController: VendorPayloadBuilder = (c) => ({
  controller: "HVAC-2",
  sampled: new Date(c.stampMs).toISOString(),
  zone: {
    temp: { value: round((c.values.zoneTemperatureC * 9) / 5 + 32, 2), unit: "degF" },
    rh: {
      value: round(
        Math.min(100, Math.max(0, c.values.relativeHumidityPct + jitter(c, "rh", 0.3))) / 100,
        4,
      ),
      unit: "fraction",
    },
  },
  backup: { status: c.values.backupRunning ? "RUN" : "STOP" },
});

/** Building Automation Gateway: one flat record for one equipment tag. Used by the Integration Lab. */
const basGateway: VendorPayloadBuilder = (c) => ({
  ts: new Date(c.stampMs).toISOString(),
  equipment: "CH-01",
  vib_rms: round(Math.max(0, c.values.vibrationRmsMs2 * (1 + jitter(c, "vib", 0.02))), 4),
  amps: round(Math.max(0, c.values.currentA * (1 + jitter(c, "cur", 0.004))), 3),
  load_pct: round(c.values.loadPercent, 1),
  run_state: c.values.primaryRunning ? "RUN" : "STOP",
});

export const VENDOR_PAYLOAD_BUILDERS: Readonly<Record<string, VendorPayloadBuilder>> = {
  "sim-vibration-gateway": vibrationGateway,
  "sim-electrical-meter": electricalMeter,
  "sim-hvac-controller": hvacController,
  "sim-bas-gateway": basGateway,
};

/** A sample for a profile, or undefined for a profile this simulator has no vendor for. */
export function buildVendorPayload(
  profileId: string,
  group: SimulatedSensorGroup | undefined,
  c: { seed: string; values: PhysicalValues; instantMs: number },
): { readonly payload: Record<string, unknown>; readonly stampMs: number } | undefined {
  const builder = VENDOR_PAYLOAD_BUILDERS[profileId];
  if (builder === undefined) return undefined;
  const stale = group === undefined ? 0 : c.values.sensors[group].staleSeconds;
  const stampMs = c.instantMs - stale * 1000;
  return { payload: builder({ ...c, stampMs }), stampMs };
}
