/**
 * The HTTP contract as the web app sees it. These mirror the JSON returned by `/api/v1` and
 * `/insurance/v1`; the web app imports no domain package (a boundary test enforces that), and a
 * compile-time test (tests/unit/web-contract.test.ts) checks these shapes stay assignable from the
 * backend's own types. Optional fields are absent in the JSON, not null.
 */

export type CaseSeverity = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
export type CaseState =
  | "OPEN"
  | "ACTION_REQUIRED"
  | "ACTION_REPORTED"
  | "VERIFYING"
  | "VERIFIED_IMPROVED"
  | "PARTIALLY_VERIFIED"
  | "NOT_IMPROVING"
  | "INCONCLUSIVE"
  | "CLOSED"
  | "REOPENED";
export type SharingState = "NOT_SHARED" | "SHAREABLE" | "SHARED" | "REVOKED";
export type InterventionLevel =
  "REMOTE_MONITORING" | "REMOTE_REVIEW" | "RISK_ENGINEER_REVIEW" | "SITE_VISIT_RECOMMENDED";
export type AgreementStatus = "NOT_YET_EFFECTIVE" | "ACTIVE" | "EXPIRED" | "REVOKED";
export type ConsentScope =
  | "RECOMMENDATION"
  | "EVENT_SUMMARY"
  | "ACTION_SUMMARY"
  | "BEFORE_AFTER_METRICS"
  | "VERIFICATION_RESULT"
  | "VERIFICATION_CONFIDENCE"
  | "RECURRENCE_STATUS"
  | "EVIDENCE_ARTIFACTS"
  | "INTERVENTION_RECOMMENDATION"
  | "RAW_TELEMETRY";

export type CriterionStatDto = {
  readonly sampleCount: number;
  readonly mean?: number;
  readonly min?: number;
  readonly max?: number;
};

export type CriterionDto = {
  readonly criterionId: string;
  readonly role: string;
  readonly outcome: string;
  readonly assetId?: string;
  readonly signal?: string;
  readonly metric?: string;
  readonly referenceMean?: number;
  readonly referenceModes: readonly string[];
  readonly before?: CriterionStatDto;
  readonly observed?: CriterionStatDto;
  readonly observedMetric?: CriterionStatDto;
  readonly reasonCodes: readonly string[];
  readonly evidenceCount: number;
};

export type VerificationDto = {
  readonly verificationId: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly postActionWindow: { readonly start: string; readonly end: string };
  readonly startedAt: string;
  readonly evaluatedAt?: string;
  readonly result?: string;
  readonly resultLabel?: string;
  readonly confidence?: number;
  readonly dataCompleteness?: number;
  readonly telemetryConfidence?: number;
  readonly deviceHealthStatus?: string;
  readonly authIntegrityStatus?: string;
  readonly reasonCodes: readonly string[];
  readonly criteria: readonly CriterionDto[];
  readonly evidenceReferenceCount: number;
};

export type DidItWorkStatus =
  | "NOT_APPLICABLE_YET"
  | "VERIFICATION_PENDING"
  | "VERIFIED_IMPROVED"
  | "PARTIALLY_VERIFIED"
  | "NOT_IMPROVING"
  | "INCONCLUSIVE"
  | "NOT_AVAILABLE";

export type InterventionDto = {
  readonly interventionId: string;
  readonly level: InterventionLevel;
  readonly label: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
  readonly generatedAt: string;
};

export type ActionDto = {
  readonly actionId: string;
  readonly actionLibraryId: string;
  readonly title: string;
  readonly status: "ASSIGNED" | "ACKNOWLEDGED" | "REPORTED_COMPLETE";
  readonly assignedTo?: string;
  readonly reportedBy?: string;
  readonly reportedAt?: string;
  readonly notes?: string;
  readonly attachments: readonly string[];
};

export type EvidenceRecordDto = {
  readonly packageId: string;
  readonly caseId: string;
  readonly verificationId: string;
  readonly result: string;
  readonly createdAt: string;
  readonly schemaVersion: string;
  readonly payloadSha256: string;
  readonly manifestSha256: string;
  readonly byteLength: number;
};

export type AgreementDto = {
  readonly agreement: {
    readonly agreementId: string;
    readonly organizationId: string;
    readonly recipientOrganizationId: string;
    readonly scopes: readonly ConsentScope[];
    readonly facilityIds: readonly string[];
    readonly effectiveFrom: string;
    readonly expiresAt?: string;
    readonly revokedAt?: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly revokedBy?: string;
    readonly revocationReason?: string;
  };
  readonly status: AgreementStatus;
  readonly sharedCaseIds: readonly string[];
};

export type CaseDto = {
  readonly caseId: string;
  readonly title: string;
  readonly hazardType: string;
  readonly severity: CaseSeverity;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly state: CaseState;
  readonly riskEventId?: string;
  readonly riskEventState?: string;
  readonly reasonCodes: readonly string[];
  readonly detectionCount: number;
  readonly latestDetectionAt?: string;
  readonly whatHappened: { readonly summary: string; readonly reasons: readonly string[] };
  readonly accountability: {
    readonly ownerId?: string;
    readonly alert: {
      readonly status: string;
      readonly recipient?: string;
      readonly sentAt?: string;
      readonly attempts: number;
      readonly deliveryFailed: boolean;
      readonly exhausted: boolean;
    };
    readonly acknowledgement: {
      readonly acknowledged: boolean;
      readonly by?: string;
      readonly at?: string;
    };
    readonly escalation: {
      readonly escalated: boolean;
      readonly at?: string;
      readonly reason?: string;
    };
  };
  readonly nextSteps: { readonly canAcknowledge: boolean; readonly canAssignOrReport: boolean };
  readonly whatToDo: {
    readonly mode: "RECOMMEND_ONLY";
    readonly approvedActions: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
      readonly description: string;
      readonly status: "AVAILABLE" | "ASSIGNED" | "REPORTED";
    }[];
  };
  readonly whatWasDone: { readonly actions: readonly ActionDto[] };
  readonly didItWork: {
    readonly status: DidItWorkStatus;
    readonly label: string;
    readonly detail: string;
  };
  readonly verification?: VerificationDto;
  readonly verificationHistory: readonly {
    readonly verificationId: string;
    readonly status: string;
    readonly result?: string;
    readonly evaluatedAt?: string;
  }[];
  readonly stayingFixed: {
    readonly watch: "NOT_ACTIVE" | "WATCHING" | "WATCH_ENDED";
    readonly watchEndsAt?: string;
    readonly recurrenceCount: number;
    readonly lastRecurrence?: { readonly at: string; readonly riskEventId: string };
  };
  readonly intervention?: InterventionDto;
  readonly evidence: {
    readonly latestEvidencePackageId?: string;
    readonly auditReferences: readonly {
      readonly auditId: string;
      readonly action: string;
      readonly at: string;
    }[];
  };
  readonly sharing: { readonly state: SharingState; readonly label: string };
  /** Added by `GET /api/v1/cases/:id` when the role may read them. */
  readonly evidencePackages?: readonly EvidenceRecordDto[];
  readonly sharingAgreements?: readonly AgreementDto[];
};

export type EvidenceDetailDto = {
  readonly record: EvidenceRecordDto;
  readonly integrity: {
    readonly valid: boolean;
    readonly issues: readonly string[];
    readonly payloadSha256: string;
    readonly manifestSha256: string;
  };
  readonly package: {
    readonly packageId: string;
    readonly createdAt: string;
    readonly schemaVersion: string;
    readonly manifest: {
      readonly hashAlgorithm: string;
      readonly canonicalization: string;
      readonly artifacts: readonly { readonly id: string; readonly kind: string }[];
    };
    readonly payload: {
      readonly source: {
        readonly dataOrigin: string;
        readonly synthetic: boolean;
        readonly label: string;
      };
      readonly verification: {
        readonly result: string;
        readonly policyId: string;
        readonly policyVersion: string;
        readonly evaluatedAt: string;
      };
      readonly auditReferences: readonly unknown[];
    };
  };
};

export type MeDto = {
  readonly actorId: string;
  readonly organizationId: string;
  readonly facilityIds: readonly string[] | "ALL";
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly identity: "DEVELOPMENT_ONLY";
};

export type IdentityDto = {
  readonly actorId: string;
  readonly organizationId: string;
  readonly facilityIds: readonly string[] | "ALL";
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
};

export type OrganizationDto = {
  readonly organizationId: string;
  readonly name: string;
  readonly type: "INSURED" | "INSURER" | "BROKER";
  readonly facilityIds: readonly string[];
};

export type DirectoryDto = {
  readonly identity: "DEVELOPMENT_ONLY";
  readonly actors: readonly IdentityDto[];
  readonly organizations: readonly OrganizationDto[];
};

// ---- insurer projections (only what the sharing agreement allows is present) -----------------

export type InsurerSiteDto = {
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly agreements: readonly {
    readonly agreementId: string;
    readonly scopes: readonly ConsentScope[];
    readonly effectiveFrom: string;
    readonly expiresAt?: string;
  }[];
};

export type InsurerBeforeAfterDto = {
  readonly criterionId: string;
  readonly role: string;
  readonly assetId?: string;
  readonly signal?: string;
  readonly metric?: string;
  readonly before?: CriterionStatDto;
  readonly after?: CriterionStatDto;
  readonly afterDeviation?: CriterionStatDto;
};

export type InsurerCaseDto = {
  readonly caseId: string;
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly consent: {
    readonly agreementIds: readonly string[];
    readonly grantedScopes: readonly ConsentScope[];
  };
  readonly sharingState: SharingState;
  readonly source?: {
    readonly dataOrigin: string;
    readonly synthetic: boolean;
    readonly label: string;
  };
  readonly evidenceAvailable?: boolean;
  readonly recommendation?: {
    readonly title: string;
    readonly hazardType: string;
    readonly severity: string;
    readonly caseState: string;
    readonly originType: string;
    readonly source?: string;
    readonly approvedActions?: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
    }[];
  };
  readonly eventSummary?: {
    readonly eventId: string;
    readonly detectedAt: string;
    readonly detectionReasonCodes: readonly string[];
  };
  readonly actionSummary?: {
    readonly acknowledgedAt: string | null;
    readonly actions: readonly {
      readonly actionLibraryId: string;
      readonly title?: string;
      readonly status: string;
      readonly assignedAt?: string;
      readonly acknowledgedAt?: string;
      readonly reportedAt?: string;
    }[];
    readonly note: string;
  };
  readonly verification?: {
    readonly result: string;
    readonly resultLabel: string;
    readonly interpretation: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly evaluatedAt: string;
    readonly baselineWindow: { readonly start: string; readonly end: string };
    readonly postActionWindow: { readonly start: string; readonly end: string };
    readonly reasonCodes: readonly string[];
    readonly criteria: readonly {
      readonly criterionId: string;
      readonly role: string;
      readonly outcome: string;
    }[];
  };
  readonly confidence?: {
    readonly confidence: number;
    readonly dataCompleteness: number;
    readonly telemetryConfidence: number;
    readonly deviceHealthStatus: string;
    readonly authIntegrityStatus: string;
  };
  readonly beforeAfter?: readonly InsurerBeforeAfterDto[];
  readonly recurrence?: {
    readonly recurrenceCountAtPackage: number;
    readonly currentRecurrenceCount: number;
    readonly reopenedSincePackage: boolean;
    readonly recurrenceWatchEndsAt: string | null;
  };
  readonly evidencePackage?: {
    readonly packageId: string;
    readonly schemaVersion: string;
    readonly createdAt: string;
    readonly hashAlgorithm: string;
    readonly canonicalization: string;
    readonly payloadSha256: string;
    readonly manifestSha256: string;
    readonly integrity: "VERIFIED";
    readonly versions: {
      readonly verificationPolicy: { readonly id: string; readonly version: string };
    };
    readonly artifacts: readonly {
      readonly id: string;
      readonly kind: string;
      readonly sha256: string;
    }[];
    readonly observationArtifactCount: number;
    readonly auditReferenceCount: number;
  };
  readonly packageHistory?: readonly {
    readonly packageId: string;
    readonly createdAt: string;
    readonly result?: string;
  }[];
  /** Only ever present for an explicit RAW_TELEMETRY request; the UI never asks for it. */
  readonly rawTelemetry?: unknown;
};

export type InsurerInterventionDto = {
  readonly interventionId: string;
  readonly caseId?: string;
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly level: InterventionLevel | string;
  readonly label: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
  readonly generatedAt: string;
  readonly note: string;
};

// ---- explanations (S8): AI or template prose about facts the system already established ---------

export type ExplanationDto = {
  readonly explanation: {
    readonly summary: string;
    readonly keyFacts: readonly string[];
    readonly whyItMatters: readonly string[];
    readonly actionContext: readonly string[];
    readonly verificationExplanation: readonly string[];
    readonly interventionExplanation: readonly string[];
    readonly evidenceExplanation: readonly string[];
    readonly limitations: readonly string[];
    readonly sourceFactIds: readonly string[];
  };
  readonly meta: {
    readonly provider: string;
    readonly model?: string;
    readonly generatedAt: string;
    readonly promptVersion: string;
    readonly schemaVersion: string;
    readonly audience: "FACILITY" | "INSURER";
    readonly caseId: string;
    readonly fallbackUsed: boolean;
    readonly fallbackReason?: string;
    readonly attemptedProvider?: string;
    readonly correlationId: string;
    readonly cached: boolean;
    readonly sources: readonly {
      readonly type: string;
      readonly id: string;
      readonly version?: string;
    }[];
  };
  readonly facts: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: string;
  }[];
};
