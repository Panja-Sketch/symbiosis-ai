import { resolveValue } from "@symbiosis/contracts";
import type {
  AdapterTrace,
  CanonicalObservation,
  DeviceHealth,
  EdgeSource,
  RejectedReading,
  Resolvable,
  TelemetryAuthenticatedEvent,
  TelemetrySourceAuthenticatedEvent,
  UnassessedObservation,
} from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { assessObservation } from "@symbiosis/data-quality";
import type { DataQualityConfig } from "@symbiosis/data-quality";
import { deviceAssetIds } from "@symbiosis/device-registry";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import { applySourceMapping, normalizeTelemetry } from "@symbiosis/normalization";
import type { AdapterCatalog, SourceAdapter } from "@symbiosis/normalization";
import type { ObservationRepository, TenantDocumentStore } from "@symbiosis/repositories";

export type TelemetryWorkerDeps = {
  readonly bus: EventBus;
  /** Source adapters keyed by the packet's declared source. */
  readonly adapters: Readonly<Partial<Record<EdgeSource, SourceAdapter>>>;
  /** Fixed in production; the simulation tenant resolves its versioned policy (D-092). */
  readonly quality: Resolvable<DataQualityConfig>;
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

  await assessAndPublish(deps, event, {
    deviceId: payload.deviceId,
    deviceHealth: payload.deviceHealth,
    observations: normalized.observations,
    rejectedReadings: normalized.rejectedReadings,
  });
}

type EventRef = {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly organization_id: string;
  readonly facility_id: string;
};

/**
 * Shared tail of every ingestion path: data quality, dedupe, then the two canonical events. Whatever
 * the vendor payload looked like, everything after this point is identical (spec principle 16).
 */
async function assessAndPublish(
  deps: Pick<TelemetryWorkerDeps, "bus" | "quality" | "observations" | "ids" | "clock">,
  event: EventRef,
  input: {
    readonly deviceId: string;
    readonly deviceHealth: DeviceHealth;
    readonly observations: readonly UnassessedObservation[];
    readonly rejectedReadings: readonly RejectedReading[];
  },
): Promise<{ readonly duplicatesDropped: number; readonly stored: number }> {
  const quality = await resolveValue(deps.quality, event.organization_id, event.facility_id);
  const fresh: { observation: CanonicalObservation; reasons: readonly string[] }[] = [];
  let duplicatesDropped = 0;
  for (const unassessed of input.observations) {
    const assessed = assessObservation(
      unassessed,
      { deviceHealth: input.deviceHealth, authVerified: true },
      quality,
    );
    const observation: CanonicalObservation = { ...unassessed, quality: assessed.quality };
    if (await deps.observations.insertIfAbsent(observation)) {
      fresh.push({ observation, reasons: assessed.reasons });
    } else duplicatesDropped += 1;
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
      deviceId: input.deviceId,
      observations: withoutQuality,
      rejectedReadings: input.rejectedReadings,
      duplicatesDropped,
    },
  });
  const assessedEvent = createEnvelope(deps.ids, {
    ...base,
    type: "telemetry.quality_assessed.v1",
    causationId: normalizedEvent.event_id,
    payload: {
      deviceId: input.deviceId,
      observations: fresh.map((f) => f.observation),
      assessments: fresh.map((f) => ({
        observationId: f.observation.observationId,
        reasons: f.reasons,
      })),
    },
  });
  await deps.bus.publish(normalizedEvent);
  await deps.bus.publish(assessedEvent);
  return { duplicatesDropped, stored: fresh.length };
}

export type SourceTelemetryWorkerDeps = Pick<
  TelemetryWorkerDeps,
  "bus" | "quality" | "observations" | "ids" | "clock"
> & {
  readonly catalog: AdapterCatalog;
  /** Where the field-by-field result of every payload is kept for the Integration Lab. */
  readonly store: TenantDocumentStore;
};

const TRACES_PER_DEVICE = 30;

/**
 * Vendor-neutral ingestion (D-088): telemetry.source_authenticated -> the pinned, versioned
 * declarative mapping -> the SAME quality, dedupe and canonical events as every other source. A
 * payload the mapping cannot accept is reported field by field and never guessed. Idempotent: the
 * trace id is derived from the device and request sequence, and duplicate observations are dropped.
 */
export function startSourceTelemetryWorker(deps: SourceTelemetryWorkerDeps): Unsubscribe {
  return deps.bus.subscribe("telemetry.source_authenticated.v1", (event) =>
    processSource(deps, event),
  );
}

async function processSource(
  deps: SourceTelemetryWorkerDeps,
  event: TelemetrySourceAuthenticatedEvent,
): Promise<void> {
  const { payload } = event;
  const org = event.organization_id;
  const record = await deps.catalog.getVersion(
    org,
    payload.profile.profileId,
    payload.profile.version,
  );
  if (record === undefined) {
    throw new Error(
      `source profile ${payload.profile.profileId}@${payload.profile.version} not found`,
    );
  }
  const def = record.definition;
  const allowedAssetIds = deviceAssetIds({
    assetId: payload.assetId,
    ...(payload.assetMapping !== undefined && { assetMapping: payload.assetMapping }),
  } as Parameters<typeof deviceAssetIds>[0]);
  const outcome = applySourceMapping(def, payload.payload, {
    organizationId: org,
    facilityId: event.facility_id,
    deviceId: payload.deviceId,
    expectedSignals: payload.expectedSignals,
    allowedAssetIds,
    receivedAt: payload.receivedAt,
  });

  const rejectedReadings: RejectedReading[] = outcome.fields
    .filter((f) => f.status === "REJECTED" && f.reason !== undefined)
    .map((f) => ({
      observedAt: outcome.observedAt ?? payload.receivedAt,
      field: f.sourcePath,
      reason: f.reason as RejectedReading["reason"],
    }));
  const published = await assessAndPublish(deps, event, {
    deviceId: payload.deviceId,
    deviceHealth: payload.deviceHealth,
    observations: outcome.observations,
    rejectedReadings,
  });

  const accepted = outcome.fields.filter((f) => f.status === "ACCEPTED").length;
  const rejected = outcome.fields.length - accepted;
  const trace: AdapterTrace = {
    traceId: `TRC-${payload.deviceId}-${payload.seq}`,
    organizationId: org,
    facilityId: event.facility_id,
    deviceId: payload.deviceId,
    profileId: def.profileId,
    version: def.version,
    sourceType: def.sourceType,
    synthetic: def.synthetic,
    mode: "INGESTED",
    receivedAt: payload.receivedAt,
    ...(outcome.observedAt !== undefined && { observedAt: outcome.observedAt }),
    payload: payload.payload,
    fields: outcome.fields,
    accepted,
    rejected,
    duplicatesDropped: published.duplicatesDropped,
    outcome: accepted === 0 ? "REJECTED" : rejected > 0 ? "PARTIAL" : "ACCEPTED",
    issues: outcome.issues,
  };
  await deps.store.put("adapterTraces", org, trace.traceId, trace, {
    deviceId: payload.deviceId,
    facilityId: event.facility_id,
    receivedAtMs: Date.parse(payload.receivedAt),
  });
  // Keep a short, bounded history per device (best effort; never fails ingestion).
  try {
    const all = await deps.store.list<AdapterTrace>("adapterTraces", org, {
      where: { deviceId: payload.deviceId },
      limit: 500,
    });
    const stale = [...all]
      .sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt))
      .slice(TRACES_PER_DEVICE);
    for (const t of stale) await deps.store.delete("adapterTraces", org, t.traceId);
  } catch {
    // pruning is housekeeping
  }
}
