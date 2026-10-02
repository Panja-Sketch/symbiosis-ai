import type { IsoTimestamp, TimeWindow } from "./primitives";
import type { CaseOrigin, CaseSeverity, CaseState } from "./case";
import type { CriterionResult, EvidenceKind, VerificationResult } from "./verification";

/** Plain JSON data. Evidence snapshots and hashing accept nothing else. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const EVIDENCE_PACKAGE_SCHEMA = "evidence-package.v1" as const;
export const EVIDENCE_MANIFEST_SCHEMA = "evidence-manifest.v1" as const;
export const EVIDENCE_CANONICALIZATION = "symbiosis-canonical-json.v1" as const;
export const EVIDENCE_HASH_ALGORITHM = "SHA-256" as const;
export const EVIDENCE_BUILDER_VERSION = "evidence-builder.v1" as const;

/** Where the underlying observations came from. Synthetic data is never presented as real. */
export const EVIDENCE_DATA_ORIGINS = [
  "SYNTHETIC_SIMULATOR",
  /** Legacy value (the abandoned bench prototype, D-085). Never produced; kept so old packages parse. */
  "PROTOTYPE_HARDWARE",
  /** Data from a customer's real integration (a building system, gateway or equipment API). */
  "CUSTOMER_INTEGRATION",
  "MIXED",
  "NONE",
] as const;
export type EvidenceDataOrigin = (typeof EVIDENCE_DATA_ORIGINS)[number];

export type EvidenceSourceLabel = {
  readonly dataOrigin: EvidenceDataOrigin;
  readonly synthetic: boolean;
  readonly sourceTypes: readonly string[];
  readonly sourceAdapters: readonly string[];
  readonly label: string;
};

/** One referenced trusted record, frozen at package creation, with its own SHA-256. */
export type EvidenceArtifact = {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly snapshot: JsonValue;
  readonly sha256: string;
};

export type EvidenceArtifactDescriptor = {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
};

export type EvidenceAuditReference = {
  readonly auditId: string;
  readonly action: string;
  readonly at: IsoTimestamp;
  readonly actorId: string;
  readonly actorType: "USER" | "SYSTEM";
  readonly targetType: string;
  readonly targetId: string;
};

export type EvidenceActionSummary = {
  readonly actionId: string;
  readonly actionLibraryId: string;
  readonly title?: string;
  readonly libraryVersion?: string;
  readonly status: string;
  readonly assignedTo?: string;
  readonly assignedAt?: IsoTimestamp;
  readonly acknowledgedAt?: IsoTimestamp;
  readonly reportedBy?: string;
  readonly reportedAt?: IsoTimestamp;
  readonly notes?: string;
  readonly attachments: readonly string[];
};

/**
 * The machine-readable facts of a verification evidence package (spec 19). Every value is copied
 * from an existing trusted record; nothing is computed, inferred or defaulted here. It contains
 * NO creation time and NO package id, so identical source records always hash identically.
 */
export type EvidencePayload = {
  readonly caseIdentity: {
    readonly caseId: string;
    readonly organizationId: string;
    readonly facilityId: string;
    readonly assetIds: readonly string[];
    readonly hazardType: string;
    readonly title: string;
    readonly severity: CaseSeverity;
    readonly state: CaseState;
    readonly recurrenceCount: number;
    readonly createdAt: IsoTimestamp;
  };
  readonly recommendation: {
    readonly origin: CaseOrigin;
    /**
     * Who raised it. A deterministic detection is a SYMBIOSIS source. UNSPECIFIED means the
     * recommendation record was not available, which is never guessed.
     */
    readonly source: "INSURER" | "FACILITY" | "SYMBIOSIS" | "IMPORTED" | "UNSPECIFIED";
    readonly recommendationId: string | null;
    readonly approvedActions: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
      readonly libraryVersion: string;
    }[];
  };
  readonly riskEvent: {
    readonly eventId: string;
    readonly state: string;
    readonly detectedAt: IsoTimestamp;
    readonly assetIds: readonly string[];
    readonly detectionReasonCodes: readonly string[];
  };
  readonly reportedActions: readonly EvidenceActionSummary[];
  readonly acknowledgement: {
    readonly auditId: string;
    readonly acknowledgedBy: string;
    readonly acknowledgedAt: IsoTimestamp;
  } | null;
  readonly baselineWindow: TimeWindow;
  readonly postActionWindow: TimeWindow;
  readonly requiredCriteria: readonly CriterionResult[];
  readonly supportingCriteria: readonly CriterionResult[];
  readonly quality: {
    readonly dataCompleteness: number;
    readonly telemetryConfidence: number;
    readonly deviceHealthStatus: string;
    readonly authIntegrityStatus: string;
  };
  /** The verification result exactly as the deterministic engine recorded it. */
  readonly verification: {
    readonly verificationId: string;
    readonly result: VerificationResult;
    readonly confidence: number;
    readonly reasonCodes: readonly string[];
    readonly evaluatedAt: IsoTimestamp;
    readonly policyId: string;
    readonly policyVersion: string;
  };
  readonly recurrence: {
    readonly recurrenceCount: number;
    readonly recurrenceWatchEndsAt: IsoTimestamp | null;
    readonly priorVerificationIds: readonly string[];
  };
  readonly versions: {
    readonly verificationPolicy: { readonly id: string; readonly version: string };
    readonly evidenceSchema: typeof EVIDENCE_PACKAGE_SCHEMA;
    readonly canonicalization: typeof EVIDENCE_CANONICALIZATION;
    readonly hashAlgorithm: typeof EVIDENCE_HASH_ALGORITHM;
    readonly builder: typeof EVIDENCE_BUILDER_VERSION;
  };
  readonly evidenceReferences: readonly EvidenceArtifactDescriptor[];
  readonly auditReferences: readonly EvidenceAuditReference[];
  readonly source: EvidenceSourceLabel;
};

export type EvidenceManifest = {
  readonly manifestSchema: typeof EVIDENCE_MANIFEST_SCHEMA;
  readonly hashAlgorithm: typeof EVIDENCE_HASH_ALGORITHM;
  readonly canonicalization: typeof EVIDENCE_CANONICALIZATION;
  readonly packageSchema: typeof EVIDENCE_PACKAGE_SCHEMA;
  readonly packageId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId: string;
  readonly verificationId: string;
  readonly createdAt: IsoTimestamp;
  readonly versions: EvidencePayload["versions"];
  readonly payloadSha256: string;
  readonly artifactCount: number;
  /** Sorted by kind then id. */
  readonly artifacts: readonly EvidenceArtifactDescriptor[];
};

/** Immutable once created. Later case activity creates a new package; this one never changes. */
export type EvidencePackage = {
  readonly packageId: string;
  readonly schemaVersion: typeof EVIDENCE_PACKAGE_SCHEMA;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId: string;
  readonly verificationId: string;
  readonly createdAt: IsoTimestamp;
  readonly payload: EvidencePayload;
  readonly artifacts: readonly EvidenceArtifact[];
  readonly manifest: EvidenceManifest;
  /** SHA-256 over the canonical bytes of `manifest`. */
  readonly manifestSha256: string;
};

/** Index entry kept in the repository; the full package lives in the object store. */
export type EvidencePackageRecord = {
  readonly packageId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId: string;
  readonly verificationId: string;
  readonly result: VerificationResult;
  readonly createdAt: IsoTimestamp;
  readonly verificationEvaluatedAt: IsoTimestamp;
  readonly schemaVersion: string;
  readonly payloadSha256: string;
  readonly manifestSha256: string;
  readonly objectKey: string;
  readonly byteLength: number;
};
