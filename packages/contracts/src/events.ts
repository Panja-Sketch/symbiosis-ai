import type { UnassessedObservation, CanonicalObservation, CanonicalSignal } from "./canonical";
import type { DeviceHealth, EdgeTelemetryPayload } from "./edge";
import type { IsoTimestamp } from "./primitives";

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
  readonly assetId: string;
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

/** All platform events defined so far. Later phases extend this union. */
export type PlatformEvent =
  | TelemetryReceivedEvent
  | TelemetryAuthenticatedEvent
  | TelemetryNormalizedEvent
  | TelemetryQualityAssessedEvent;

export type PlatformEventType = PlatformEvent["event_type"];
export type EventOfType<T extends PlatformEventType> = Extract<PlatformEvent, { event_type: T }>;
