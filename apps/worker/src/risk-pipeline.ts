import { baselineKeyString } from "@symbiosis/contracts";
import type { Baseline, TelemetryQualityAssessedEvent } from "@symbiosis/contracts";
import type { BaselineConfig } from "@symbiosis/baselines";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  BaselineRepository,
  CaseRepository,
  DetectionStateRepository,
  RiskEventRepository,
} from "@symbiosis/repositories";
import { applyCaseCommand } from "@symbiosis/risk-cases";
import { detectionStateKey, emptyDetectionState, evaluateSample } from "@symbiosis/risk-detection";
import type { RuleConfig } from "@symbiosis/risk-detection";
import { openCaseFromDetection } from "@symbiosis/risk-lifecycle";

export type RiskPipelineDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly baselines: BaselineRepository;
  readonly detectionStates: DetectionStateRepository;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly rule: RuleConfig;
  readonly baselineConfig: BaselineConfig;
};

/**
 * S3 pipeline: telemetry.quality_assessed -> baseline learning + rule evaluation ->
 * risk.observation_evaluated* -> (risk.detected -> case.created | case.updated).
 * Deterministic and AI-free. Emits nothing about alerts, actions or verification (S4+).
 */
export function startRiskPipeline(deps: RiskPipelineDeps): Unsubscribe {
  return deps.bus.subscribe("telemetry.quality_assessed.v1", (event) => process(deps, event));
}

async function process(
  deps: RiskPipelineDeps,
  event: TelemetryQualityAssessedEvent,
): Promise<void> {
  const { payload } = event;
  if (payload.observations.length === 0) return; // nothing was evaluated (e.g. all duplicates)

  const org = event.organization_id;
  const fac = event.facility_id;
  const book: Record<string, Baseline> = {};
  for (const b of await deps.baselines.listActive(org, fac)) book[baselineKeyString(b.key)] = b;
  const state =
    (await deps.detectionStates.get(detectionStateKey(org, fac, deps.rule.ruleId))) ??
    emptyDetectionState(org, fac, deps.rule.ruleId);

  const result = evaluateSample({
    organizationId: org,
    facilityId: fac,
    observations: payload.observations,
    state,
    baselines: book,
    rule: deps.rule,
    baselineConfig: deps.baselineConfig,
  });

  for (const b of result.changedBaselines) await deps.baselines.save(b);
  await deps.detectionStates.save(result.state);

  const base = {
    correlationId: event.correlation_id,
    organizationId: org,
    facilityId: fac,
    occurredAt: nowIso(deps.clock),
    producer: "worker" as const,
  };

  // The first CANDIDATE_RISK evaluation event per (asset, instant) causes a detection.
  const candidateEventFor = new Map<string, string>();
  for (const evaluation of result.evaluations) {
    const envelope = createEnvelope(deps.ids, {
      ...base,
      type: "risk.observation_evaluated.v1",
      causationId: event.event_id,
      payload: evaluation,
    });
    await deps.bus.publish(envelope);
    const k = `${evaluation.assetId}|${evaluation.observedAt}`;
    if (evaluation.outcome === "CANDIDATE_RISK" && !candidateEventFor.has(k)) {
      candidateEventFor.set(k, envelope.event_id);
    }
  }

  for (const detection of result.detections) {
    const cause =
      candidateEventFor.get(`${detection.primaryAssetId}|${detection.detectedAt}`) ??
      event.event_id;
    const detected = createEnvelope(deps.ids, {
      ...base,
      type: "risk.detected.v1",
      causationId: cause,
      payload: detection,
    });
    await deps.bus.publish(detected);

    const existing = await deps.cases.findActive(
      org,
      fac,
      detection.hazardType,
      detection.primaryAssetId,
    );

    if (existing === undefined) {
      const snapshot = {
        snapshotId: deps.ids.next("BSNAP"),
        organizationId: org,
        facilityId: fac,
        baselineIds: detection.baselineIds,
        createdAt: detection.detectedAt,
      };
      await deps.baselines.saveSnapshot(snapshot);
      const opened = openCaseFromDetection({
        detection,
        caseId: deps.ids.next("CASE"),
        eventId: deps.ids.next("RE"),
        baselineSnapshotId: snapshot.snapshotId,
      });
      if (!opened.ok) throw new Error(`cannot open case: ${opened.error.message}`);
      await deps.riskEvents.save(opened.value.event);
      await deps.cases.save(opened.value.case);
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base,
          type: "case.created.v1",
          causationId: detected.event_id,
          payload: {
            caseId: opened.value.case.caseId,
            riskEventId: opened.value.event.eventId,
            detectionId: detection.detectionId,
            hazardType: opened.value.case.hazardType,
            severity: opened.value.case.severity,
            state: opened.value.case.state,
            assetIds: opened.value.case.assetIds,
            baselineSnapshotId: snapshot.snapshotId,
          },
        }),
      );
      continue;
    }

    // Same episode: update the existing case; never create a duplicate. If the case is in a
    // state that cannot accept it (S4+ workflow states), the detection is still on the bus.
    const updated = applyCaseCommand(existing, {
      type: "RECORD_DETECTION",
      at: detection.detectedAt,
      detectionId: detection.detectionId,
      severity: detection.severity,
    });
    if (!updated.ok) continue;
    await deps.cases.save(updated.value.value);
    await deps.bus.publish(
      createEnvelope(deps.ids, {
        ...base,
        type: "case.updated.v1",
        causationId: detected.event_id,
        payload: {
          caseId: existing.caseId,
          riskEventId: existing.activeRiskEventId ?? "",
          detectionId: detection.detectionId,
          change: "DETECTION_CONTINUED" as const,
          severity: updated.value.value.severity,
          previousSeverity: existing.severity,
          state: updated.value.value.state,
        },
      }),
    );
  }
}
