import { baselineKeyString, resolveValue } from "@symbiosis/contracts";
import type { Baseline, Resolvable, TelemetryQualityAssessedEvent } from "@symbiosis/contracts";
import type { BaselineConfig } from "@symbiosis/baselines";
import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  BaselineRepository,
  CaseRepository,
  DetectionStateRepository,
  RiskEventRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import { applyCaseCommand } from "@symbiosis/risk-cases";
import { detectionStateKey, emptyDetectionState, evaluateSample } from "@symbiosis/risk-detection";
import type { RuleConfig } from "@symbiosis/risk-detection";
import { openCaseFromDetection } from "@symbiosis/risk-lifecycle";
import { decideRecurrence, reopenCaseForRecurrence } from "@symbiosis/recurrence";

export type RiskPipelineDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly baselines: BaselineRepository;
  readonly detectionStates: DetectionStateRepository;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly verifications: VerificationRepository;
  readonly audit: AuditLog;
  /** Fixed in production; the simulation tenant resolves its versioned policy (D-092). */
  readonly rule: Resolvable<RuleConfig>;
  readonly baselineConfig: Resolvable<BaselineConfig>;
};

/**
 * S3 pipeline: telemetry.quality_assessed -> baseline learning + rule evaluation ->
 * risk.observation_evaluated* -> (risk.detected -> case.created | case.updated | recurrence).
 * Deterministic and AI-free. Before ordinary case correlation, a qualifying detection that
 * matches a VERIFIED_IMPROVED case inside its recurrence-watch window reopens that case instead of
 * creating a second one (S5, spec 8.3). Alerts, actions and verification are other components.
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
  const rule = await resolveValue(deps.rule, org, fac);
  const baselineConfig = await resolveValue(deps.baselineConfig, org, fac);
  const book: Record<string, Baseline> = {};
  for (const b of await deps.baselines.listActive(org, fac)) book[baselineKeyString(b.key)] = b;
  const state =
    (await deps.detectionStates.get(detectionStateKey(org, fac, rule.ruleId))) ??
    emptyDetectionState(org, fac, rule.ruleId);

  const result = evaluateSample({
    organizationId: org,
    facilityId: fac,
    observations: payload.observations,
    state,
    baselines: book,
    rule,
    baselineConfig,
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

    // Recurrence first (S5): a persistent compound detection against a verified case inside its
    // watch window reopens that same case; it never creates a second Risk Improvement Case.
    const verifiedCases = await deps.cases.findVerifiedImproved(
      org,
      fac,
      detection.hazardType,
      detection.primaryAssetId,
    );
    const decision = decideRecurrence({
      detection,
      candidates: await Promise.all(
        verifiedCases.map(async (caseRecord) => ({
          caseRecord,
          verification:
            caseRecord.latestVerificationId === undefined
              ? undefined
              : await deps.verifications.get(org, caseRecord.latestVerificationId),
        })),
      ),
    });
    if (decision.kind === "REOPEN") {
      const reopened = reopenCaseForRecurrence({
        caseRecord: decision.caseRecord,
        detection,
        newEventId: deps.ids.next("RE"),
      });
      // Failing closed: never fall through to opening a duplicate case.
      if (!reopened.ok) throw new Error(`cannot reopen case: ${reopened.error.message}`);
      const { case: reopenedCase, newEvent, previousRiskEventId } = reopened.value;
      await deps.riskEvents.save(newEvent);
      await deps.cases.save(reopenedCase);
      const auditBase = {
        organizationId: org,
        facilityId: fac,
        caseId: reopenedCase.caseId,
        actorId: "SYSTEM-RECURRENCE",
        actorType: "SYSTEM" as const,
        correlationId: event.correlation_id,
        at: detection.detectedAt,
      };
      await deps.audit.append({
        ...auditBase,
        action: "RECURRENCE_DETECTED",
        targetType: "CASE",
        targetId: reopenedCase.caseId,
        beforeState: decision.caseRecord.state,
        afterState: reopenedCase.state,
        details: {
          detectionId: detection.detectionId,
          previousRiskEventId,
          newRiskEventId: newEvent.eventId,
          previousVerificationId: decision.verification.verificationId,
          recurrenceCount: reopenedCase.recurrenceCount,
          severity: detection.severity,
          confidence: detection.confidence,
          reasonCodes: detection.reasonCodes,
        },
      });
      await deps.audit.append({
        ...auditBase,
        action: "CASE_REOPENED",
        targetType: "CASE",
        targetId: reopenedCase.caseId,
        beforeState: decision.caseRecord.state,
        afterState: reopenedCase.state,
        details: { riskEventId: newEvent.eventId, recurrenceCount: reopenedCase.recurrenceCount },
      });
      const recurrence = createEnvelope(deps.ids, {
        ...base,
        type: "recurrence.detected.v1",
        causationId: detected.event_id,
        payload: {
          caseId: reopenedCase.caseId,
          previousRiskEventId,
          newRiskEventId: newEvent.eventId,
          previousVerificationId: decision.verification.verificationId,
          detectionId: detection.detectionId,
          hazardType: detection.hazardType,
          primaryAssetId: detection.primaryAssetId,
          severity: detection.severity,
          recurrenceCount: reopenedCase.recurrenceCount,
          recurrenceWatchEndsAt: decision.watchEndsAt,
          detectedAt: detection.detectedAt,
          reasonCodes: detection.reasonCodes,
        },
      });
      await deps.bus.publish(recurrence);
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base,
          type: "case.reopened.v1",
          causationId: recurrence.event_id,
          payload: {
            caseId: reopenedCase.caseId,
            riskEventId: newEvent.eventId,
            previousState: decision.caseRecord.state,
            state: reopenedCase.state,
            severity: reopenedCase.severity,
            recurrenceCount: reopenedCase.recurrenceCount,
          },
        }),
      );
      continue;
    }

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
      await deps.audit.append({
        organizationId: org,
        facilityId: fac,
        caseId: opened.value.case.caseId,
        actorId: "SYSTEM-DETECTION",
        actorType: "SYSTEM",
        action: "CASE_CREATED",
        targetType: "CASE",
        targetId: opened.value.case.caseId,
        afterState: opened.value.case.state,
        correlationId: event.correlation_id,
        at: detection.detectedAt,
        details: {
          detectionId: detection.detectionId,
          riskEventId: opened.value.event.eventId,
          severity: detection.severity,
          confidence: detection.confidence,
          reasonCodes: detection.reasonCodes,
        },
      });
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

    // Same episode: record the detection on the existing case (state preserved, severity may only
    // rise) and in the audit trail; never create a duplicate case. A case in a state that cannot
    // accept it (VERIFYING and later, S5) still has the detection on the bus.
    const updated = applyCaseCommand(existing, {
      type: "RECORD_DETECTION",
      at: detection.detectedAt,
      detectionId: detection.detectionId,
      severity: detection.severity,
    });
    if (!updated.ok) continue;
    await deps.cases.save(updated.value.value);
    await deps.audit.append({
      organizationId: org,
      facilityId: fac,
      caseId: existing.caseId,
      actorId: "SYSTEM-DETECTION",
      actorType: "SYSTEM",
      action: "DETECTION_RECORDED",
      targetType: "CASE",
      targetId: existing.caseId,
      beforeState: existing.state,
      afterState: updated.value.value.state,
      correlationId: event.correlation_id,
      at: detection.detectedAt,
      details: {
        detectionId: detection.detectionId,
        severity: detection.severity,
        confidence: detection.confidence,
        reasonCodes: detection.reasonCodes,
      },
    });
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
          previousState: existing.state,
          severity: updated.value.value.severity,
          previousSeverity: existing.severity,
          state: updated.value.value.state,
        },
      }),
    );
  }
}
