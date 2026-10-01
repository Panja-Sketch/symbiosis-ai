import type {
  CanonicalObservation,
  EdgeSource,
  TelemetryAuthenticatedEvent,
  UnassessedObservation,
} from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { assessObservation } from "@symbiosis/data-quality";
import type { DataQualityConfig } from "@symbiosis/data-quality";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import { normalizeTelemetry } from "@symbiosis/normalization";
import type { SourceAdapter } from "@symbiosis/normalization";
import type { ObservationRepository } from "@symbiosis/repositories";

export const PACKAGE_NAME = "@symbiosis/worker" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export * from "./risk-pipeline";
export * from "./verification-runner";

export type TelemetryWorkerDeps = {
  readonly bus: EventBus;
  /** Source adapters keyed by the packet's declared source. */
  readonly adapters: Readonly<Partial<Record<EdgeSource, SourceAdapter>>>;
  readonly quality: DataQualityConfig;
  readonly observations: ObservationRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
};

/**
 * S2 telemetry pipeline: telemetry.authenticated -> normalize -> data quality -> dedupe ->
 * telemetry.normalized -> telemetry.quality_assessed. Emits nothing downstream of that: no
 * baselines, detection or risk events (S3+). Duplicate observations (device + signal +
 * observed_at) are dropped before either event is emitted. The handler is idempotent, as
 * brokers deliver at least once.
 */
export function startTelemetryWorker(deps: TelemetryWorkerDeps): Unsubscribe {
  return deps.bus.subscribe("telemetry.authenticated.v1", (event) =>
    processAuthenticated(deps, event),
  );
}

async function processAuthenticated(
  deps: TelemetryWorkerDeps,
  event: TelemetryAuthenticatedEvent,
): Promise<void> {
  const { payload } = event;
  const adapter = deps.adapters[payload.telemetry.source];
  if (adapter === undefined) {
    throw new Error(`no source adapter registered for ${payload.telemetry.source}`);
  }

  const normalized = normalizeTelemetry(adapter, payload.telemetry, {
    organizationId: event.organization_id,
    facilityId: event.facility_id,
    assetId: payload.assetId,
    ...(payload.assetMapping !== undefined && { assetMapping: payload.assetMapping }),
    deviceId: payload.deviceId,
    expectedSignals: payload.expectedSignals,
    receivedAt: payload.receivedAt,
  });

  const fresh: { observation: CanonicalObservation; reasons: readonly string[] }[] = [];
  let duplicatesDropped = 0;
  for (const unassessed of normalized.observations) {
    const { quality, reasons } = assessObservation(
      unassessed,
      { deviceHealth: payload.deviceHealth, authVerified: true },
      deps.quality,
    );
    const observation: CanonicalObservation = { ...unassessed, quality };
    if (await deps.observations.insertIfAbsent(observation)) fresh.push({ observation, reasons });
    else duplicatesDropped += 1;
  }

  const base = {
    correlationId: event.correlation_id,
    organizationId: event.organization_id,
    facilityId: event.facility_id,
    occurredAt: nowIso(deps.clock),
    producer: "worker" as const,
  };
  const withoutQuality: UnassessedObservation[] = fresh.map(({ observation }) => ({
    observationId: observation.observationId,
    organizationId: observation.organizationId,
    facilityId: observation.facilityId,
    assetId: observation.assetId,
    deviceId: observation.deviceId,
    signal: observation.signal,
    value: observation.value,
    unit: observation.unit,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    sourceType: observation.sourceType,
    sourceAdapter: observation.sourceAdapter,
  }));
  const normalizedEvent = createEnvelope(deps.ids, {
    ...base,
    type: "telemetry.normalized.v1",
    causationId: event.event_id,
    payload: {
      deviceId: payload.deviceId,
      observations: withoutQuality,
      rejectedReadings: normalized.rejectedReadings,
      duplicatesDropped,
    },
  });
  const assessedEvent = createEnvelope(deps.ids, {
    ...base,
    type: "telemetry.quality_assessed.v1",
    causationId: normalizedEvent.event_id,
    payload: {
      deviceId: payload.deviceId,
      observations: fresh.map((f) => f.observation),
      assessments: fresh.map((f) => ({
        observationId: f.observation.observationId,
        reasons: f.reasons,
      })),
    },
  });
  await deps.bus.publish(normalizedEvent);
  await deps.bus.publish(assessedEvent);
}
