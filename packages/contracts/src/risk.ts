import type { BaselineStatus } from "./baseline";
import type { CaseSeverity } from "./case";
import type { CanonicalSignal } from "./canonical";
import type { IsoTimestamp } from "./primitives";

export const EVALUATION_OUTCOMES = [
  "NORMAL",
  "WATCH",
  "CANDIDATE_RISK",
  "INSUFFICIENT_DATA",
] as const;
export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export type EvaluationMetrics = {
  readonly vibrationZ?: number;
  readonly currentDeviationPercent?: number;
  readonly outdoorTemperatureDegF?: number;
  readonly zoneTemperatureSlopeDegCPerHour?: number;
};

/**
 * Deterministic account of how one observation was considered by baseline/risk logic.
 * Contains only facts and reason codes, never generated language.
 */
export type ObservationEvaluation = {
  readonly observationId: string;
  readonly assetId: string;
  readonly signal: CanonicalSignal;
  readonly observedAt: IsoTimestamp;
  /** How this observation contributed. */
  readonly outcome: EvaluationOutcome;
  /** Result of the whole rule at this sample instant for the primary asset. */
  readonly instantOutcome: EvaluationOutcome;
  readonly reasonCodes: readonly string[];
  readonly ruleId: string;
  readonly ruleVersion: string;
  /** Baseline used or being learned for this observation's own signal, if any. */
  readonly baseline?: {
    readonly baselineId: string;
    readonly status: BaselineStatus;
    readonly operatingMode: string;
  };
  readonly metrics: EvaluationMetrics;
  readonly persistence?: { readonly qualifyingEvaluations: number; readonly required: number };
};

/** A deterministic risk finding: persistent compound deterioration (never a single signal). */
export type RiskDetection = {
  readonly detectionId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly hazardType: string;
  /** The asset carrying the primary signals; part of the case-correlation key. */
  readonly primaryAssetId: string;
  readonly contextAssetIds: readonly string[];
  readonly severity: CaseSeverity;
  /** Lowest telemetry confidence among the primary observations (0..1). */
  readonly confidence: number;
  readonly detectedAt: IsoTimestamp;
  readonly reasonCodes: readonly string[];
  readonly supportingObservationIds: readonly string[];
  readonly baselineIds: readonly string[];
  readonly persistence: { readonly qualifyingEvaluations: number; readonly required: number };
  readonly metrics: EvaluationMetrics;
};

export type DetectionFact = {
  readonly observationId: string;
  readonly assetId: string;
  readonly signal: string;
  readonly value: number | boolean;
  readonly unit: string;
  readonly observedAt: IsoTimestamp;
  readonly trusted: boolean;
  readonly trustReasons: readonly string[];
  readonly confidence: number;
};

export type DetectionSample = { readonly t: number; readonly v: number };

export type DetectionPersistence = {
  readonly streak: number;
  readonly lastQualifyingAt?: IsoTimestamp;
  readonly lastCountedAt?: IsoTimestamp;
};

/** Serializable detector memory for one (organization, facility, rule). */
export type DetectionState = {
  readonly stateKey: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly ruleId: string;
  /** Latest fact per `${assetId}|${signal}`, trusted or not (untrusted facts are never used). */
  readonly facts: Readonly<Record<string, DetectionFact>>;
  /** Trusted zone-temperature samples per asset, for the slope branch. */
  readonly zoneSamples: Readonly<Record<string, readonly DetectionSample[]>>;
  /** Persistence per primary asset. */
  readonly persistence: Readonly<Record<string, DetectionPersistence>>;
};
