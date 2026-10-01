import { err, ok } from "./result";
import type { Result } from "./result";
import { isIsoTimestamp, isNonEmptyString } from "./primitives";

/** Edge endpoint paths (spec section 32). These exact strings are signed. */
export const EDGE_PATHS = {
  telemetry: "/edge/v1/telemetry",
  heartbeat: "/edge/v1/heartbeat",
} as const;

export const EDGE_SOURCES = ["HARDWARE", "SIMULATOR"] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

export type EdgeReadingValue = number | boolean;

export type EdgeTelemetrySample = {
  readonly observed_at: string;
  readonly readings: Readonly<Record<string, EdgeReadingValue>>;
};

/** Source-specific telemetry body (spec section 33). Field names stay source-specific. */
export type EdgeTelemetryPayload = {
  readonly device_id: string;
  readonly firmware_version: string;
  readonly source: EdgeSource;
  readonly batch: readonly EdgeTelemetrySample[];
};

export const DEVICE_HEALTH_VALUES = ["HEALTHY", "DEGRADED", "FAULT", "UNKNOWN"] as const;
export type DeviceHealth = (typeof DEVICE_HEALTH_VALUES)[number];

/** A heartbeat may only report a concrete health; UNKNOWN is a registry-side default. */
export const HEARTBEAT_HEALTH_VALUES = ["HEALTHY", "DEGRADED", "FAULT"] as const;

export type EdgeHeartbeatPayload = {
  readonly device_id: string;
  readonly firmware_version: string;
  readonly sent_at: string;
  readonly health: (typeof HEARTBEAT_HEALTH_VALUES)[number];
};

export const MAX_BATCH_SIZE = 100;
export const MAX_READINGS_PER_SAMPLE = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEdgeTelemetry(
  value: unknown,
): Result<EdgeTelemetryPayload, readonly string[]> {
  if (!isRecord(value)) return err(["body must be a JSON object"]);
  const issues: string[] = [];
  if (!isNonEmptyString(value.device_id)) issues.push("device_id is required");
  if (!isNonEmptyString(value.firmware_version)) issues.push("firmware_version is required");
  if (!(EDGE_SOURCES as readonly unknown[]).includes(value.source)) {
    issues.push("source must be HARDWARE or SIMULATOR");
  }
  const batch = value.batch;
  if (!Array.isArray(batch) || batch.length === 0) {
    issues.push("batch must be a non-empty array");
  } else if (batch.length > MAX_BATCH_SIZE) {
    issues.push(`batch must not exceed ${MAX_BATCH_SIZE} samples`);
  } else {
    batch.forEach((sample: unknown, i) => {
      if (!isRecord(sample)) {
        issues.push(`batch[${i}] must be an object`);
        return;
      }
      if (!isIsoTimestamp(sample.observed_at)) {
        issues.push(`batch[${i}].observed_at must be ISO-8601`);
      }
      const readings = sample.readings;
      if (!isRecord(readings) || Object.keys(readings).length === 0) {
        issues.push(`batch[${i}].readings must be a non-empty object`);
        return;
      }
      if (Object.keys(readings).length > MAX_READINGS_PER_SAMPLE) {
        issues.push(`batch[${i}].readings has too many fields`);
        return;
      }
      for (const [field, v] of Object.entries(readings)) {
        const valid = typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
        if (!valid) issues.push(`batch[${i}].readings.${field} must be a finite number or boolean`);
      }
    });
  }
  return issues.length > 0 ? err(issues) : ok(value as unknown as EdgeTelemetryPayload);
}

export function parseEdgeHeartbeat(
  value: unknown,
): Result<EdgeHeartbeatPayload, readonly string[]> {
  if (!isRecord(value)) return err(["body must be a JSON object"]);
  const issues: string[] = [];
  if (!isNonEmptyString(value.device_id)) issues.push("device_id is required");
  if (!isNonEmptyString(value.firmware_version)) issues.push("firmware_version is required");
  if (!isIsoTimestamp(value.sent_at)) issues.push("sent_at must be ISO-8601");
  if (!(HEARTBEAT_HEALTH_VALUES as readonly unknown[]).includes(value.health)) {
    issues.push("health must be HEALTHY, DEGRADED or FAULT");
  }
  return issues.length > 0 ? err(issues) : ok(value as unknown as EdgeHeartbeatPayload);
}
