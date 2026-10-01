import type {
  ConsentScope,
  CriterionResult,
  CriterionStat,
  EvidenceArtifactDescriptor,
  EvidencePackage,
  EvidenceSourceLabel,
  RiskEngineerInterventionRecommendation,
  RiskImprovementCase,
  SharingState,
} from "@symbiosis/contracts";
import { RESULT_DETAILS, RESULT_LABELS } from "@symbiosis/verification";
import { EVIDENCE_PACKAGE_SCOPES } from "./access";

/**
 * Insurer-facing evidence projections (spec 20, 43). These are purpose-built DTOs, never the
 * internal case or package objects: every field is added only when the agreement grants the scope
 * that covers it, so what the insurer receives is exactly what the insured allowed. Nothing here
 * reads telemetry, the device registry, notes, actor ids or attachments; the only raw-telemetry
 * path is `projectRawTelemetry`, which the gateway calls solely under an explicit RAW_TELEMETRY
 * scope on an explicit request.
 */

const INTERVENTION_LABELS = {
  REMOTE_MONITORING: "Remote Monitoring",
  REMOTE_REVIEW: "Remote Review",
  RISK_ENGINEER_REVIEW: "Risk Engineer Review",
  SITE_VISIT_RECOMMENDED: "Site Visit Recommended",
} as const;

export type InsurerSourceLabel = Pick<EvidenceSourceLabel, "dataOrigin" | "synthetic" | "label">;

type CriterionBeforeAfter = {
  readonly criterionId: string;
  readonly role: string;
  readonly assetId?: string;
  readonly signal?: string;
  readonly metric?: string;
  readonly referenceMean?: number;
  readonly referenceOperatingModes: readonly string[];
  readonly before?: CriterionStat;
  readonly after?: CriterionStat;
  readonly afterDeviation?: CriterionStat;
  readonly thresholds?: Readonly<Record<string, number>>;
};

export type InsurerCaseView = {
  readonly caseId: string;
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly consent: {
    readonly agreementIds: readonly string[];
    readonly grantedScopes: readonly ConsentScope[];
  };
  readonly sharingState: SharingState;
  /** Present whenever any package-derived section is: synthetic data is always labelled. */
  readonly source?: InsurerSourceLabel;
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
  readonly beforeAfter?: readonly CriterionBeforeAfter[];
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
    /** Recomputed by the server before release; a failing package is never released. */
    readonly integrity: "VERIFIED";
    readonly versions: {
      readonly verificationPolicy: { readonly id: string; readonly version: string };
    };
    readonly artifacts: readonly EvidenceArtifactDescriptor[];
    /** Raw observations are counted, never listed, without the RAW_TELEMETRY scope. */
    readonly observationArtifactCount: number;
    readonly auditReferenceCount: number;
  };
};

export type InsurerEvidenceView = InsurerCaseView & {
  readonly packageHistory?: readonly {
    readonly packageId: string;
    readonly createdAt: string;
    readonly result?: string;
  }[];
  readonly rawTelemetry?: {
    readonly scope: "RAW_TELEMETRY";
    readonly note: string;
    readonly observations: readonly unknown[];
  };
};

function beforeAfter(c: CriterionResult): CriterionBeforeAfter {
  return {
    criterionId: c.criterionId,
    role: c.role ?? "REQUIRED",
    ...(c.assetId !== undefined && { assetId: c.assetId }),
    ...(c.signal !== undefined && { signal: c.signal }),
    ...(c.metric !== undefined && { metric: c.metric }),
    ...(c.reference?.mean !== undefined && { referenceMean: c.reference.mean }),
    referenceOperatingModes: c.reference?.operatingModes ?? [],
    ...(c.before !== undefined && { before: c.before }),
    ...(c.observed !== undefined && { after: c.observed }),
    ...(c.observedMetric !== undefined && { afterDeviation: c.observedMetric }),
    ...(c.thresholds !== undefined && { thresholds: c.thresholds }),
  };
}

export type ProjectCaseInput = {
  readonly caseRecord: RiskImprovementCase;
  readonly agreementIds: readonly string[];
  readonly grantedScopes: readonly ConsentScope[];
  /** A package that already passed integrity verification, or undefined when none exists. */
  readonly pkg?: EvidencePackage;
};

/** Builds the scope-filtered view of one case. Absent scope means absent field. */
export function projectCase(input: ProjectCaseInput): InsurerCaseView {
  const { caseRecord: c, pkg } = input;
  const has = (s: ConsentScope) => input.grantedScopes.includes(s);
  const anyPackageScope = EVIDENCE_PACKAGE_SCOPES.some(has);
  const p = pkg?.payload;
  const showPackage = pkg !== undefined && p !== undefined && anyPackageScope;

  return {
    caseId: c.caseId,
    siteId: c.facilityId,
    insuredOrganizationId: c.organizationId,
    consent: { agreementIds: [...input.agreementIds], grantedScopes: [...input.grantedScopes] },
    sharingState: c.sharingState,
    ...(showPackage && {
      source: {
        dataOrigin: p.source.dataOrigin,
        synthetic: p.source.synthetic,
        label: p.source.label,
      },
    }),
    ...(anyPackageScope && { evidenceAvailable: pkg !== undefined }),
    ...(has("RECOMMENDATION") && {
      recommendation: {
        title: c.title,
        hazardType: c.hazardType,
        severity: c.severity,
        caseState: c.state,
        originType: c.origin.type,
        ...(p !== undefined && { source: p.recommendation.source }),
        ...(p !== undefined && {
          approvedActions: p.recommendation.approvedActions.map((a) => ({
            actionLibraryId: a.actionLibraryId,
            title: a.title,
          })),
        }),
      },
    }),
    ...(showPackage &&
      has("EVENT_SUMMARY") && {
        eventSummary: {
          eventId: p.riskEvent.eventId,
          detectedAt: p.riskEvent.detectedAt,
          detectionReasonCodes: p.riskEvent.detectionReasonCodes,
        },
      }),
    ...(showPackage &&
      has("ACTION_SUMMARY") && {
        actionSummary: {
          acknowledgedAt: p.acknowledgement?.acknowledgedAt ?? null,
          actions: p.reportedActions.map((a) => ({
            actionLibraryId: a.actionLibraryId,
            ...(a.title !== undefined && { title: a.title }),
            status: a.status,
            ...(a.assignedAt !== undefined && { assignedAt: a.assignedAt }),
            ...(a.acknowledgedAt !== undefined && { acknowledgedAt: a.acknowledgedAt }),
            ...(a.reportedAt !== undefined && { reportedAt: a.reportedAt }),
          })),
          note: "A reported action is evidence that an action was reported, not that the risk improved.",
        },
      }),
    ...(showPackage &&
      has("VERIFICATION_RESULT") && {
        verification: {
          result: p.verification.result,
          resultLabel: RESULT_LABELS[p.verification.result],
          interpretation: RESULT_DETAILS[p.verification.result],
          policyId: p.verification.policyId,
          policyVersion: p.verification.policyVersion,
          evaluatedAt: p.verification.evaluatedAt,
          baselineWindow: p.baselineWindow,
          postActionWindow: p.postActionWindow,
          reasonCodes: p.verification.reasonCodes,
          criteria: [...p.requiredCriteria, ...p.supportingCriteria].map((x) => ({
            criterionId: x.criterionId,
            role: x.role ?? "REQUIRED",
            outcome: x.outcome ?? (x.passed ? "PASS" : "FAIL"),
          })),
        },
      }),
    ...(showPackage &&
      has("VERIFICATION_CONFIDENCE") && {
        confidence: {
          confidence: p.verification.confidence,
          dataCompleteness: p.quality.dataCompleteness,
          telemetryConfidence: p.quality.telemetryConfidence,
          deviceHealthStatus: p.quality.deviceHealthStatus,
          authIntegrityStatus: p.quality.authIntegrityStatus,
        },
      }),
    ...(showPackage &&
      has("BEFORE_AFTER_METRICS") && {
        beforeAfter: [...p.requiredCriteria, ...p.supportingCriteria].map(beforeAfter),
      }),
    ...(showPackage &&
      has("RECURRENCE_STATUS") && {
        recurrence: {
          recurrenceCountAtPackage: p.recurrence.recurrenceCount,
          currentRecurrenceCount: c.recurrenceCount,
          reopenedSincePackage: c.recurrenceCount > p.recurrence.recurrenceCount,
          recurrenceWatchEndsAt: p.recurrence.recurrenceWatchEndsAt,
        },
      }),
    ...(showPackage &&
      has("EVIDENCE_ARTIFACTS") && {
        evidencePackage: {
          packageId: pkg.packageId,
          schemaVersion: pkg.schemaVersion,
          createdAt: pkg.createdAt,
          hashAlgorithm: pkg.manifest.hashAlgorithm,
          canonicalization: pkg.manifest.canonicalization,
          payloadSha256: pkg.manifest.payloadSha256,
          manifestSha256: pkg.manifestSha256,
          integrity: "VERIFIED" as const,
          versions: { verificationPolicy: p.versions.verificationPolicy },
          artifacts: pkg.manifest.artifacts.filter((a) => a.kind !== "OBSERVATION"),
          observationArtifactCount: pkg.manifest.artifacts.filter((a) => a.kind === "OBSERVATION")
            .length,
          auditReferenceCount: p.auditReferences.length,
        },
      }),
  };
}

/**
 * The only raw-telemetry projection. Callers must have checked that the RAW_TELEMETRY scope is
 * active and that the request explicitly asked for it; nothing else in this package returns
 * observation values.
 */
export function projectRawTelemetry(
  pkg: EvidencePackage,
): NonNullable<InsurerEvidenceView["rawTelemetry"]> {
  return {
    scope: "RAW_TELEMETRY",
    note: "Raw observations released under an explicit RAW_TELEMETRY consent scope.",
    observations: pkg.artifacts.filter((a) => a.kind === "OBSERVATION").map((a) => a.snapshot),
  };
}

export type InsurerInterventionView = {
  readonly interventionId: string;
  readonly caseId?: string;
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly level: string;
  readonly label: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
  readonly generatedAt: string;
  readonly note: string;
};

export function projectIntervention(
  r: RiskEngineerInterventionRecommendation,
): InsurerInterventionView {
  return {
    interventionId: r.interventionId,
    ...(r.caseId !== undefined && { caseId: r.caseId }),
    siteId: r.facilityId,
    insuredOrganizationId: r.organizationId,
    level: r.level,
    label: INTERVENTION_LABELS[r.level],
    status: r.status,
    policyId: r.policyId,
    policyVersion: r.policyVersion,
    reasonCodes: r.reasonCodes,
    dataSufficiency: r.dataSufficiency,
    generatedAt: r.generatedAt,
    note: "Decision support only: it schedules no one and changes no coverage, pricing or underwriting.",
  };
}
