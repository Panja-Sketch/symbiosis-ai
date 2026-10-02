import type { CanonicalSignal, SourceType } from "./canonical";
import type { IsoTimestamp } from "./primitives";

/**
 * Declarative source-adapter mapping (S10, D-088). A vendor's own payload shape is described as DATA:
 * where each value lives, which unit it is in, which asset it belongs to. There is deliberately no
 * expression language, script, regular expression or callback: a definition is validated against a
 * closed schema and anything else fails closed.
 */
export const SOURCE_MAPPING_SCHEMA = "source-mapping.v1" as const;

export const SOURCE_MAPPING_SOURCE_TYPES = ["SIMULATOR", "BMS", "OEM_API", "HARDWARE"] as const;
export type SourceMappingSourceType = Extract<
  SourceType,
  (typeof SOURCE_MAPPING_SOURCE_TYPES)[number]
>;

export const TIMESTAMP_FORMATS = ["ISO_8601", "EPOCH_SECONDS", "EPOCH_MILLIS"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMATS)[number];

/** Where a numeric reading's unit comes from. Every accepted unit must be convertible. */
export type MappingUnit =
  { readonly fixed: string } | { readonly path: string; readonly allowed: readonly string[] };

/**
 * Asset placement: a source identifier (at `path`) looked up in `map`, or one `fixed` asset. The
 * result must be an asset the authenticated device is registered for (the registry decides).
 */
export type MappingAsset = {
  readonly path?: string;
  readonly map?: Readonly<Record<string, string>>;
  readonly fixed?: string;
};

export type SourceMappingField = {
  readonly signal: CanonicalSignal;
  /** Overrides the profile's asset placement for this reading (a controller may report several assets). */
  readonly asset?: MappingAsset;
  /** Location of the value inside the sample (dotted keys and `[n]` indexes only). */
  readonly path: string;
  readonly valueType: "number" | "boolean";
  /** Numeric readings only. */
  readonly unit?: MappingUnit;
  /** Boolean readings from text, e.g. `{ "RUN": true, "STOP": false }`. Closed list. */
  readonly enum?: Readonly<Record<string, boolean>>;
  /** Plausibility bounds in CANONICAL units after conversion; outside means rejected. */
  readonly bounds?: { readonly min: number; readonly max: number };
  /** Plain-text remark for evaluators; never interpreted. */
  readonly note?: string;
};

export type SourceMappingDefinition = {
  readonly schema: typeof SOURCE_MAPPING_SCHEMA;
  readonly profileId: string;
  /** Positive integer, assigned by the mapping store when a version is published. */
  readonly version: number;
  readonly displayName: string;
  readonly vendorLabel: string;
  readonly description: string;
  readonly sourceType: SourceMappingSourceType;
  /** True for synthetic profiles; a synthetic profile must use sourceType SIMULATOR and vice versa. */
  readonly synthetic: boolean;
  readonly timestamp: { readonly path: string; readonly format: TimestampFormat };
  readonly asset: MappingAsset;
  /** Optional array of samples; field, timestamp and asset paths are then relative to each element. */
  readonly samples?: { readonly path: string };
  readonly fields: readonly SourceMappingField[];
};

export const REJECT_REASONS = [
  "MISSING_FIELD",
  "VALUE_TYPE_MISMATCH",
  "INVALID_VALUE",
  "INCOMPATIBLE_UNIT",
  "OUT_OF_BOUNDS",
  "UNMAPPED_ASSET",
  "ASSET_NOT_PERMITTED",
  "SIGNAL_NOT_EXPECTED",
  "INVALID_TIMESTAMP",
  "UNKNOWN_ENUM_VALUE",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** What happened to one mapped field of one payload; the Integration Lab shows these as rows. */
export type FieldTrace = {
  readonly signal: CanonicalSignal;
  readonly sourcePath: string;
  /** The raw value as the vendor sent it (JSON). */
  readonly sourceValue: string | number | boolean | null;
  readonly sourceUnit?: string;
  readonly canonicalUnit: string;
  /** Human-readable conversion, e.g. `value x 9.80665` or `identity`. */
  readonly conversion: string;
  readonly sourceAsset?: string;
  readonly assetId?: string;
  readonly canonicalValue?: number | boolean;
  readonly status: "ACCEPTED" | "REJECTED";
  readonly reason?: RejectReason;
  readonly detail?: string;
};

export type AdapterTrace = {
  readonly traceId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly deviceId?: string;
  readonly profileId: string;
  readonly version: number;
  readonly sourceType: SourceMappingSourceType;
  readonly synthetic: boolean;
  /** "INGESTED": the payload went through real ingestion. "DRY_RUN": evaluated only, stored nowhere. */
  readonly mode: "INGESTED" | "DRY_RUN";
  readonly receivedAt: IsoTimestamp;
  readonly observedAt?: IsoTimestamp;
  readonly payload: unknown;
  readonly fields: readonly FieldTrace[];
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicatesDropped: number;
  readonly outcome: "ACCEPTED" | "PARTIAL" | "REJECTED";
  readonly issues: readonly string[];
};
