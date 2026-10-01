import type { IsoTimestamp } from "./primitives";

/** Canonical signal vocabulary (spec section 9). Never contains hardware model names. */
export const CANONICAL_SIGNALS = [
  "temperature",
  "relative_humidity",
  "vibration_rms",
  "current",
  "load_percent",
  "equipment_running",
  "water_presence",
  "flow",
  "outdoor_temperature",
] as const;
export type CanonicalSignal = (typeof CANONICAL_SIGNALS)[number];

/** Signals whose value is boolean; all others are numeric. */
export const BOOLEAN_SIGNALS: readonly CanonicalSignal[] = ["equipment_running", "water_presence"];

export const SOURCE_TYPES = ["HARDWARE", "SIMULATOR", "BMS", "OEM_API", "WEATHER_API"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type ObservationQuality = {
  readonly confidence: number;
  readonly stale: boolean;
  readonly outOfRange: boolean;
  readonly deviceHealthy: boolean;
  readonly authVerified: boolean;
};

export type CanonicalObservation = {
  readonly observationId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetId: string;
  readonly deviceId: string;

  readonly signal: CanonicalSignal;
  readonly value: number | boolean;
  readonly unit: string;

  readonly observedAt: IsoTimestamp;
  readonly receivedAt: IsoTimestamp;

  readonly sourceType: SourceType;
  readonly sourceAdapter: string;

  readonly quality: ObservationQuality;
};

/** A normalized observation before data-quality assessment has attached `quality`. */
export type UnassessedObservation = Omit<CanonicalObservation, "quality">;

/**
 * Observation dedupe identity (spec section 9): device_id + signal + observed_at.
 * This is distinct from HTTP replay protection (nonce/sequence), which guards requests.
 */
export function observationDedupeKey(
  o: Pick<CanonicalObservation, "deviceId" | "signal" | "observedAt">,
): string {
  return `${o.deviceId}|${o.signal}|${o.observedAt}`;
}
