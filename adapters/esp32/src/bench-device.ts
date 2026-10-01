import type { DeviceRecord } from "@symbiosis/device-registry";

/**
 * Registry template for the physical bench prototype (S10). One device observes three logical
 * assets, so the SERVER holds the placement (spec section 28) and the firmware stays unaware of
 * business assets:
 *   - vibration and current        -> the primary cooling asset (the default asset)
 *   - zone temperature / humidity  -> the zone asset
 *   - the backup fan running state -> the backup asset
 * The asset ids are the existing logical assets the versioned verification policy already names
 * (config/verification-policy), so no policy change is needed. They are logical ids, not proof
 * that the data is synthetic: provenance is carried per observation by `sourceType = HARDWARE`.
 *
 * `load_percent` and `outdoor_temperature` are not measured by this prototype and are therefore
 * not expected signals (the firmware never sends them).
 */
export const BENCH_ASSETS = {
  primary: "AST-SIM-FAN-A",
  zone: "AST-SIM-ZONE-1",
  backup: "AST-SIM-FAN-B",
} as const;

export const BENCH_DEVICE_ID_PATTERN = /^DEV-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const BENCH_KEY_ID_PATTERN = /^KEY-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export type BenchDeviceInput = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly organizationId: string;
  readonly facilityId: string;
};

export function createBenchDeviceRecord(input: BenchDeviceInput): DeviceRecord {
  if (!BENCH_DEVICE_ID_PATTERN.test(input.deviceId)) {
    throw new Error("deviceId must look like DEV-UPPER-CASE-001");
  }
  if (!BENCH_KEY_ID_PATTERN.test(input.keyId)) {
    throw new Error("keyId must look like KEY-UPPER-CASE-001");
  }
  if (input.organizationId === "" || input.facilityId === "") {
    throw new Error("organizationId and facilityId are required");
  }
  return {
    deviceId: input.deviceId,
    organizationId: input.organizationId,
    facilityId: input.facilityId,
    assetId: BENCH_ASSETS.primary,
    assetMapping: {
      bySignal: {
        temperature: BENCH_ASSETS.zone,
        relative_humidity: BENCH_ASSETS.zone,
      },
      byField: { chiller_b_running: BENCH_ASSETS.backup },
    },
    status: "ACTIVE",
    activeKeyId: input.keyId,
    expectedSignals: [
      "temperature",
      "relative_humidity",
      "vibration_rms",
      "current",
      "equipment_running",
    ],
    capabilities: ["telemetry", "heartbeat"],
    // Never treated as healthy until the first heartbeat reports otherwise.
    health: "UNKNOWN",
  };
}
