import type {
  AssetMapping,
  CanonicalSignal,
  EdgeTelemetryPayload,
  RejectedReading,
  SourceType,
  UnassessedObservation,
} from "@symbiosis/contracts";
import { BOOLEAN_SIGNALS } from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/normalization" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/**
 * Normalization is where source-specific field names end. Everything downstream (quality,
 * detection, verification) sees only canonical signals; no hardware or sensor model names
 * exist outside source adapters.
 */
export type FieldMapping = {
  readonly signal: CanonicalSignal;
  readonly unit: string;
  readonly valueType: "number" | "boolean";
  /** Converts the source value into the canonical unit. */
  readonly convert?: (value: number) => number;
};

export interface SourceAdapter {
  readonly adapterName: string;
  readonly sourceType: SourceType;
  readonly fields: Readonly<Record<string, FieldMapping>>;
}

/** Field mapping for the edge v1 telemetry contract (spec section 33). */
export const EDGE_V1_FIELDS: Readonly<Record<string, FieldMapping>> = {
  temperature_c: { signal: "temperature", unit: "degC", valueType: "number" },
  relative_humidity_pct: { signal: "relative_humidity", unit: "%", valueType: "number" },
  vibration_rms_ms2: { signal: "vibration_rms", unit: "m/s2", valueType: "number" },
  current_ma: { signal: "current", unit: "A", valueType: "number", convert: (v) => v / 1000 },
  fan_a_load_pct: { signal: "load_percent", unit: "%", valueType: "number" },
  chiller_b_running: { signal: "equipment_running", unit: "boolean", valueType: "boolean" },
  outdoor_temperature_c: { signal: "outdoor_temperature", unit: "degC", valueType: "number" },
};

/**
 * Hardware and simulator packets share ONE mapping so equivalent packets normalize to the
 * same canonical shape (spec principle 16). Only the adapter name and source type differ.
 */
export function createEdgeV1Adapter(options: {
  readonly adapterName: string;
  readonly sourceType: SourceType;
}): SourceAdapter {
  return { ...options, fields: EDGE_V1_FIELDS };
}

export const EDGE_DEVICE_ADAPTER_NAME = "edge-device-v1" as const;

/**
 * Generic adapter for a real integration that already speaks the edge v1 telemetry contract
 * (`source: HARDWARE`). It names no vendor: a customer gateway sends the same flat readings the
 * simulator does. Vendor-specific payloads use a versioned source-adapter profile instead (D-088).
 */
export const edgeDeviceSourceAdapter: SourceAdapter = createEdgeV1Adapter({
  adapterName: EDGE_DEVICE_ADAPTER_NAME,
  sourceType: "HARDWARE",
});

export type NormalizeContext = {
  readonly organizationId: string;
  readonly facilityId: string;
  /** Default asset for readings `assetMapping` does not place elsewhere. */
  readonly assetId: string;
  readonly assetMapping?: AssetMapping;
  readonly deviceId: string;
  readonly expectedSignals: readonly CanonicalSignal[];
  readonly receivedAt: string;
};

export type NormalizationResult = {
  readonly observations: readonly UnassessedObservation[];
  readonly rejectedReadings: readonly RejectedReading[];
};

/** Resolves a reading's logical asset: byField, then bySignal, then the default asset. */
export function resolveAssetId(
  mapping: AssetMapping | undefined,
  field: string,
  signal: CanonicalSignal,
  defaultAssetId: string,
): string {
  return mapping?.byField?.[field] ?? mapping?.bySignal?.[signal] ?? defaultAssetId;
}

/** Deterministic observation ID derived from the dedupe identity. */
export function observationIdFor(deviceId: string, signal: CanonicalSignal, observedAt: string) {
  return `OBS-${deviceId}-${signal}-${observedAt}`;
}

/**
 * Converts a validated telemetry payload into canonical observations. Readings that cannot
 * be mapped are reported, never silently dropped or guessed. `observed_at` is canonicalized
 * to UTC ISO-8601 with milliseconds so equal instants share one dedupe identity.
 */
export function normalizeTelemetry(
  adapter: SourceAdapter,
  payload: EdgeTelemetryPayload,
  ctx: NormalizeContext,
): NormalizationResult {
  const observations: UnassessedObservation[] = [];
  const rejectedReadings: RejectedReading[] = [];

  for (const sample of payload.batch) {
    const observedAt = new Date(sample.observed_at).toISOString();
    for (const field of Object.keys(sample.readings).sort()) {
      const raw = sample.readings[field];
      const mapping = adapter.fields[field];
      if (mapping === undefined || raw === undefined) {
        rejectedReadings.push({ observedAt, field, reason: "UNMAPPED_FIELD" });
        continue;
      }
      if (typeof raw !== mapping.valueType) {
        rejectedReadings.push({ observedAt, field, reason: "VALUE_TYPE_MISMATCH" });
        continue;
      }
      if (!ctx.expectedSignals.includes(mapping.signal)) {
        rejectedReadings.push({ observedAt, field, reason: "SIGNAL_NOT_EXPECTED" });
        continue;
      }
      const isBoolean = BOOLEAN_SIGNALS.includes(mapping.signal);
      const value =
        typeof raw === "number" && !isBoolean && mapping.convert ? mapping.convert(raw) : raw;
      observations.push({
        observationId: observationIdFor(ctx.deviceId, mapping.signal, observedAt),
        organizationId: ctx.organizationId,
        facilityId: ctx.facilityId,
        assetId: resolveAssetId(ctx.assetMapping, field, mapping.signal, ctx.assetId),
        deviceId: ctx.deviceId,
        signal: mapping.signal,
        value,
        unit: mapping.unit,
        observedAt,
        receivedAt: ctx.receivedAt,
        sourceType: adapter.sourceType,
        sourceAdapter: adapter.adapterName,
      });
    }
  }
  return { observations, rejectedReadings };
}
