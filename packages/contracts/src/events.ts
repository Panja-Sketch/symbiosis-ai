import type { CaseSeverity, CaseState } from "./case";
import type { Alert, AlertKind, NotificationChannel, NotificationResult } from "./operations";
import type { ObservationEvaluation, RiskDetection } from "./risk";
import type { UnassessedObservation, CanonicalObservation, CanonicalSignal } from "./canonical";
import type { AssetMapping, DeviceHealth, EdgeTelemetryPayload } from "./edge";
import type { IsoTimestamp, TimeWindow } from "./primitives";
import type { InterventionLevel, InterventionStatus } from "./intervention";
import type { RequiredSignal, VerificationResult } from "./verification";

export const EVENT_SCHEMA_VERSION = "1.0" as const;

export type EventProducer = "api" | "worker";

/** Common event envelope (spec section 14). */
export type EventEnvelope<TType extends string, TPayload> = {
  readonly event_id: string;
  readonly event_type: TType;
  readonly schema_version: typeof EVENT_SCHEMA_VERSION;
  readonly correlation_id: string;
  /** The event that directly caused this one; null for a chain's first event. */
  readonly causation_id: string | null;
  readonly organization_id: string;
  readonly facility_id: string;
  readonly occurred_at: IsoTimestamp;
  readonly producer: EventProducer;
  readonly payload: TPayload;
};

export type TelemetryReceivedPayload = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly seq: number;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly receivedAt: IsoTimestamp;
};

export type TelemetryAuthenticatedPayload = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly seq: number;
  readonly receivedAt: IsoTimestamp;
  /** Default asset for readings the mapping does not place elsewhere. */
  readonly assetId: string;
  readonly assetMapping?: AssetMapping;
  readonly expectedSignals: readonly CanonicalSignal[];
  /** Registry-known health at receipt. UNKNOWN is never treated as healthy. */
  readonly deviceHealth: DeviceHealth;
  readonly telemetry: EdgeTelemetryPayload;
};

export type RejectedReading = {
  readonly observedAt: IsoTimestamp;
  readonly field: string;
  readonly reason: "UNMAPPED_FIELD" | "VALUE_TYPE_MISMATCH" | "SIGNAL_NOT_EXPECTED";
};

export type TelemetryNormalizedPayload = {
  readonly deviceId: string;
  readonly observations: readonly UnassessedObservation[];
  readonly rejectedReadings: readonly RejectedReading[];
  readonly duplicatesDropped: number;
};

export type TelemetryQualityAssessedPayload = {
  readonly deviceId: string;
  readonly observations: readonly CanonicalObservation[];
  /** Why each observation received its quality; empty reasons means no concerns. */
  readonly assessments: readonly {
    readonly observationId: string;
    readonly reasons: readonly string[];
  }[];
};

export type TelemetryReceivedEvent = EventEnvelope<
  "telemetry.received.v1",
  TelemetryReceivedPayload
>;
export type TelemetryAuthenticatedEvent = EventEnvelope<
  "telemetry.authenticated.v1",
  TelemetryAuthenticatedPayload
>;
export type TelemetryNormalizedEvent = EventEnvelope<
  "telemetry.normalized.v1",
  TelemetryNormalizedPayload
>;
export type TelemetryQualityAssessedEvent = EventEnvelope<
  "telemetry.quality_assessed.v1",
  TelemetryQualityAssessedPayload
>;

export type RiskObservationEvaluatedPayload = ObservationEvaluation;
export type RiskDetectedPayload = RiskDetection;

export type CaseCreatedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly detectionId: string;
  readonly hazardType: string;
  readonly severity: CaseSeverity;
  readonly state: CaseState;
  /** The primary asset is first (case-correlation convention). */
  readonly assetIds: readonly string[];
  readonly baselineSnapshotId: string;
};

export const CASE_CHANGES = [
  "DETECTION_CONTINUED",
  "ACTION_REQUIRED",
  "ACTION_REPORTED",
  "CASE_CLOSED",
  "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED",
] as const;
export type CaseChange = (typeof CASE_CHANGES)[number];

export type CaseUpdatedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly change: CaseChange;
  readonly state: CaseState;
  readonly previousState: CaseState;
  readonly severity: CaseSeverity;
  readonly previousSeverity: CaseSeverity;
  readonly detectionId?: string;
  readonly actionId?: string;
};

/** Deterministic alert facts; carries no raw telemetry and no generated language. */
export type AlertRequestedPayload = Omit<
  Alert,
  "attempts" | "status" | "exhausted" | "nextRetryAt" | "sentAt"
>;

export type NotificationRequestedPayload = {
  readonly notificationId: string;
  readonly alertId: string;
  readonly alertKind: AlertKind;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly channel: NotificationChannel;
  readonly recipientRef: string;
  readonly subject: string;
  readonly attempt: number;
  readonly requestedAt: IsoTimestamp;
};

export type NotificationOutcomePayload = {
  readonly alertId: string;
  readonly alertKind: AlertKind;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly attempt: number;
  readonly result: NotificationResult;
  /** Set when a failed attempt will be retried. */
  readonly nextRetryAt?: IsoTimestamp;
};

export type RiskAlertedPayload = {
  readonly alertId: string;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly alertedAt: IsoTimestamp;
};

export type RiskAcknowledgedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly actorId: string;
  readonly acknowledgedAt: IsoTimestamp;
  readonly note?: string;
};

export type RiskEscalatedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly escalatedAt: IsoTimestamp;
  readonly reason: "ACKNOWLEDGEMENT_OVERDUE" | "ALERT_DELIVERY_EXHAUSTED";
  readonly acknowledgementDeadlineSeconds: number;
  readonly previousState: "ALERTED" | "DETECTED";
};

export type RiskDismissedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly actorId: string;
  readonly dismissedAt: IsoTimestamp;
  readonly reason: string;
};

export type ActionAssignedPayload = {
  readonly actionId: string;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly actionLibraryId: string;
  readonly actionLibraryVersion: string;
  readonly assignedTo: string;
  readonly assignedBy: string;
  readonly assignedAt: IsoTimestamp;
};

export type ActionAcknowledgedPayload = {
  readonly actionId: string;
  readonly caseId: string;
  readonly actorId: string;
  readonly acknowledgedAt: IsoTimestamp;
};

/** A reported action is evidence that something was reported, never that risk improved. */
export type ActionReportedPayload = {
  readonly actionId: string;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly actionLibraryId: string;
  readonly reportedBy: string;
  readonly reportedAt: IsoTimestamp;
  readonly hasNotes: boolean;
  readonly attachmentCount: number;
};

export type VerificationStartedPayload = {
  readonly verificationId: string;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly actionIds: readonly string[];
  readonly postActionWindow: TimeWindow;
  readonly requiredSignals: readonly RequiredSignal[];
  readonly startedAt: IsoTimestamp;
};

/** Result of deterministic verification over trusted post-action observations (S5). */
export type VerificationCompletedPayload = {
  readonly verificationId: string;
  readonly caseId: string;
  readonly riskEventId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly result: VerificationResult;
  readonly confidence: number;
  readonly completeness: number;
  readonly telemetryConfidence: number;
  readonly reasonCodes: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly evaluatedAt: IsoTimestamp;
};

export type RecurrenceDetectedPayload = {
  readonly caseId: string;
  readonly previousRiskEventId: string;
  readonly newRiskEventId: string;
  readonly previousVerificationId: string;
  readonly detectionId: string;
  readonly hazardType: string;
  readonly primaryAssetId: string;
  readonly severity: CaseSeverity;
  readonly recurrenceCount: number;
  readonly recurrenceWatchEndsAt: IsoTimestamp;
  readonly detectedAt: IsoTimestamp;
  readonly reasonCodes: readonly string[];
};

export type CaseReopenedPayload = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly previousState: CaseState;
  readonly state: CaseState;
  readonly severity: CaseSeverity;
  readonly recurrenceCount: number;
};

export type InterventionRecommendationUpdatedPayload = {
  readonly interventionId: string;
  readonly caseId?: string;
  readonly level: InterventionLevel;
  readonly previousLevel?: InterventionLevel;
  readonly status: InterventionStatus;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly supersededInterventionId?: string;
  readonly generatedAt: IsoTimestamp;
};

export type RiskObservationEvaluatedEvent = EventEnvelope<
  "risk.observation_evaluated.v1",
  RiskObservationEvaluatedPayload
>;
export type RiskDetectedEvent = EventEnvelope<"risk.detected.v1", RiskDetectedPayload>;
export type CaseCreatedEvent = EventEnvelope<"case.created.v1", CaseCreatedPayload>;
export type CaseUpdatedEvent = EventEnvelope<"case.updated.v1", CaseUpdatedPayload>;
export type RiskAlertRequestedEvent = EventEnvelope<
  "risk.alert_requested.v1",
  AlertRequestedPayload
>;
export type NotificationRequestedEvent = EventEnvelope<
  "notification.requested.v1",
  NotificationRequestedPayload
>;
export type NotificationSentEvent = EventEnvelope<
  "notification.sent.v1",
  NotificationOutcomePayload
>;
export type NotificationFailedEvent = EventEnvelope<
  "notification.failed.v1",
  NotificationOutcomePayload
>;
export type RiskAlertedEvent = EventEnvelope<"risk.alerted.v1", RiskAlertedPayload>;
export type RiskAcknowledgedEvent = EventEnvelope<"risk.acknowledged.v1", RiskAcknowledgedPayload>;
export type RiskEscalatedEvent = EventEnvelope<"risk.escalated.v1", RiskEscalatedPayload>;
export type RiskDismissedEvent = EventEnvelope<"risk.dismissed.v1", RiskDismissedPayload>;
export type ActionAssignedEvent = EventEnvelope<"action.assigned.v1", ActionAssignedPayload>;
export type ActionAcknowledgedEvent = EventEnvelope<
  "action.acknowledged.v1",
  ActionAcknowledgedPayload
>;
export type ActionReportedEvent = EventEnvelope<"action.reported.v1", ActionReportedPayload>;

export type VerificationStartedEvent = EventEnvelope<
  "verification.started.v1",
  VerificationStartedPayload
>;
export type VerificationCompletedEvent = EventEnvelope<
  "verification.completed.v1",
  VerificationCompletedPayload
>;
export type RecurrenceDetectedEvent = EventEnvelope<
  "recurrence.detected.v1",
  RecurrenceDetectedPayload
>;
export type CaseReopenedEvent = EventEnvelope<"case.reopened.v1", CaseReopenedPayload>;
export type InterventionRecommendationUpdatedEvent = EventEnvelope<
  "intervention.recommendation_updated.v1",
  InterventionRecommendationUpdatedPayload
>;

/** All platform events defined so far. Later phases extend this union. */
export type PlatformEvent =
  | TelemetryReceivedEvent
  | TelemetryAuthenticatedEvent
  | TelemetryNormalizedEvent
  | TelemetryQualityAssessedEvent
  | RiskObservationEvaluatedEvent
  | RiskDetectedEvent
  | CaseCreatedEvent
  | CaseUpdatedEvent
  | RiskAlertRequestedEvent
  | NotificationRequestedEvent
  | NotificationSentEvent
  | NotificationFailedEvent
  | RiskAlertedEvent
  | RiskAcknowledgedEvent
  | RiskEscalatedEvent
  | RiskDismissedEvent
  | ActionAssignedEvent
  | ActionAcknowledgedEvent
  | ActionReportedEvent
  | VerificationStartedEvent
  | VerificationCompletedEvent
  | RecurrenceDetectedEvent
  | CaseReopenedEvent
  | InterventionRecommendationUpdatedEvent;

export type PlatformEventType = PlatformEvent["event_type"];
export type EventOfType<T extends PlatformEventType> = Extract<PlatformEvent, { event_type: T }>;
