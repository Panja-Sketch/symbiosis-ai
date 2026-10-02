import type {
  AuditEntry,
  Baseline,
  CriterionResult,
  DeviceFactSnapshot,
  DomainError,
  EvidenceReference,
  MitigationAction,
  Resolvable,
  RiskImprovementCase,
  TimeWindow,
  VerificationAssessment,
  VerificationAttempt,
} from "@symbiosis/contracts";
import { resolveValue } from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import type { BaselineConfig } from "@symbiosis/baselines";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { deviceAssetIds } from "@symbiosis/device-registry";
import type { DeviceRegistry } from "@symbiosis/device-registry";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";
import type {
  ActionRepository,
  BaselineRepository,
  CaseRepository,
  ObservationRepository,
  RiskEventRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import { completeVerification, startVerification } from "@symbiosis/risk-lifecycle";
import {
  evaluateVerification,
  postActionWindowFor,
  requiredSignalsFor,
} from "@symbiosis/verification";
import type { DeviceFact, VerificationPolicy } from "@symbiosis/verification";

export type VerificationRunnerDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly actions: ActionRepository;
  readonly observations: ObservationRepository;
  readonly baselines: BaselineRepository;
  readonly verifications: VerificationRepository;
  readonly registry: DeviceRegistry;
  /** Fixed in production; the simulation tenant resolves its versioned policy (D-092). */
  readonly policy: Resolvable<VerificationPolicy>;
  readonly baselineConfig: Resolvable<BaselineConfig>;
  /**
   * Finds the exact policy version an attempt started under, so a policy edited while a verification
   * is open never changes how that verification is judged. Absent: only the current policy is known.
   */
  readonly policyByVersion?: (
    organizationId: string,
    facilityId: string,
    policyId: string,
    policyVersion: string,
  ) => VerificationPolicy | undefined | Promise<VerificationPolicy | undefined>;
};

export type VerificationFailure = {
  readonly caseId?: string;
  readonly verificationId?: string;
  readonly code:
    | "NO_POLICY_FOR_HAZARD"
    | "NO_REPORTED_ACTION"
    | "START_REJECTED"
    | "COMPLETE_REJECTED"
    | "STATE_MISMATCH"
    | "PROCESSING_FAILURE";
  readonly message: string;
  readonly domain?: DomainError;
};

export type VerificationTickResult = {
  readonly started: readonly { caseId: string; verificationId: string }[];
  readonly completed: readonly { caseId: string; verificationId: string; result: string }[];
  readonly failures: readonly VerificationFailure[];
};

export type VerificationRunner = {
  /** Starts verification for every case whose action was reported (ACTION_REPORTED). */
  startDue(): Promise<Pick<VerificationTickResult, "started" | "failures">>;
  /** Completes every IN_PROGRESS verification whose post-action window has ended. */
  evaluateDue(): Promise<Pick<VerificationTickResult, "completed" | "failures">>;
  /** One scheduler pass: start, then evaluate. */
  tick(): Promise<VerificationTickResult>;
};

const laterIso = (...isos: string[]) =>
  new Date(Math.max(...isos.map((i) => Date.parse(i)))).toISOString();

/**
 * Verification application service (S5). It is the ONLY code that starts or completes a
 * verification, and it concludes only from the deterministic engine over stored canonical
 * observations: no action report, button, note or AI output can substitute. It is driven by the
 * scheduler seam (`tick`), exactly like escalation (D-033), so nothing is evaluated before the
 * post-action window ends and tests use simulated time.
 *
 * Safety: a coordinator failure, a processing error or a repository error never marks anything
 * VERIFIED. State changes are computed first and persisted afterwards; a failure leaves the
 * attempt IN_PROGRESS (or the case untouched) and is reported in the tick result.
 */
export function createVerificationRunner(deps: VerificationRunnerDeps): VerificationRunner {
  const policyFor = (organizationId: string, facilityId: string) =>
    resolveValue(deps.policy, organizationId, facilityId);

  /** The policy an attempt started under: the current one if it matches, else the pinned version. */
  async function policyForAttempt(attempt: VerificationAttempt): Promise<VerificationPolicy> {
    const current = await policyFor(attempt.organizationId, attempt.facilityId);
    if (current.policyId === attempt.policyId && current.policyVersion === attempt.policyVersion) {
      return current;
    }
    const pinned = await deps.policyByVersion?.(
      attempt.organizationId,
      attempt.facilityId,
      attempt.policyId,
      attempt.policyVersion,
    );
    if (pinned === undefined) {
      throw new Error(
        `verification policy ${attempt.policyId} version ${attempt.policyVersion} is unavailable`,
      );
    }
    return pinned;
  }

  /**
   * The device facts the engine is given, plus a frozen copy of them. The copy is stored on the
   * completed attempt so evidence built later describes the devices as they were at verification
   * time, not as the live registry happens to look then (S6 snapshot semantics).
   */
  async function deviceFacts(
    c: RiskImprovementCase,
    capturedAt: string,
  ): Promise<{ facts: DeviceFact[]; snapshots: DeviceFactSnapshot[] }> {
    const devices = await deps.registry.listForFacility(c.organizationId, c.facilityId);
    return {
      facts: devices.map((d) => ({
        deviceId: d.deviceId,
        organizationId: d.organizationId,
        facilityId: d.facilityId,
        status: d.status,
        health: d.health,
        assetIds: deviceAssetIds(d),
      })),
      snapshots: devices.map((d) => ({
        deviceId: d.deviceId,
        organizationId: d.organizationId,
        facilityId: d.facilityId,
        status: d.status,
        health: d.health,
        assetIds: [...deviceAssetIds(d)],
        ...(d.firmwareVersion !== undefined && { firmwareVersion: d.firmwareVersion }),
        ...(d.lastSeenAt !== undefined && { lastSeenAt: d.lastSeenAt }),
        capturedAt,
      })),
    };
  }

  const startedBase = (
    c: RiskImprovementCase,
    correlationId: string,
    causationId: string | null,
  ) => ({
    correlationId,
    causationId,
    organizationId: c.organizationId,
    facilityId: c.facilityId,
    occurredAt: nowIso(deps.clock),
    producer: "worker" as const,
  });

  async function startDue() {
    const started: { caseId: string; verificationId: string }[] = [];
    const failures: VerificationFailure[] = [];

    for (const c of await deps.cases.listAllForSystemTick()) {
      if (c.state !== "ACTION_REPORTED" || c.activeRiskEventId === undefined) continue;
      try {
        const event = await deps.riskEvents.get(c.organizationId, c.activeRiskEventId);
        if (event === undefined || event.state !== "ACTION_REPORTED") continue;
        const policy = await policyFor(c.organizationId, c.facilityId);
        if (c.hazardType !== policy.hazardType) {
          failures.push({
            caseId: c.caseId,
            code: "NO_POLICY_FOR_HAZARD",
            message: `No verification policy for hazard ${c.hazardType}`,
          });
          continue;
        }
        const attempts = await deps.verifications.listByCase(c.organizationId, c.caseId);
        if (attempts.some((a) => a.eventId === event.eventId && a.status === "IN_PROGRESS")) {
          continue;
        }
        const already = new Set(attempts.flatMap((a) => a.actionIds));
        const cycleActions = (await deps.actions.listByCase(c.organizationId, c.caseId)).filter(
          (a) =>
            a.eventId === event.eventId &&
            a.status === "REPORTED_COMPLETE" &&
            a.reportedAt !== undefined &&
            !already.has(a.actionId),
        );
        if (cycleActions.length === 0) {
          failures.push({
            caseId: c.caseId,
            code: "NO_REPORTED_ACTION",
            message: "No newly reported action for this risk event",
          });
          continue;
        }
        const latestReportedAt = laterIso(...cycleActions.map((a) => a.reportedAt as string));
        const actionLibraryIds = [...new Set(cycleActions.map((a) => a.actionLibraryId))];
        const at = laterIso(nowIso(deps.clock), c.updatedAt, event.updatedAt);
        const coordinated = startVerification({ case: c, event, at });
        if (!coordinated.ok) {
          failures.push({
            caseId: c.caseId,
            code: "START_REJECTED",
            message: coordinated.error.message,
            domain: coordinated.error,
          });
          continue;
        }

        // causation/correlation come from the durable audit record of the action report
        const trail = await deps.audit.listByCase(c.organizationId, c.caseId);
        const reportAudit = [...trail]
          .filter(
            (e) =>
              e.action === "ACTION_REPORTED" && cycleActions.some((a) => a.actionId === e.targetId),
          )
          .sort((a, b) => b.sequence - a.sequence)[0];
        const correlationId = reportAudit?.correlationId ?? deps.ids.next("CORR");
        const reportEventId =
          typeof reportAudit?.details?.emittedEventId === "string"
            ? reportAudit.details.emittedEventId
            : null;

        const window = postActionWindowFor(policy, latestReportedAt);
        const requiredSignals = requiredSignalsFor(policy, c, actionLibraryIds);
        const verificationId = deps.ids.next("VER");
        const envelope = createEnvelope(deps.ids, {
          ...startedBase(c, correlationId, reportEventId),
          type: "verification.started.v1",
          payload: {
            verificationId,
            caseId: c.caseId,
            riskEventId: event.eventId,
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            actionIds: cycleActions.map((a) => a.actionId),
            postActionWindow: window,
            requiredSignals,
            startedAt: at,
          },
        });
        const attempt: VerificationAttempt = {
          verificationId,
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          caseId: c.caseId,
          eventId: event.eventId,
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          actionIds: cycleActions.map((a) => a.actionId),
          actionLibraryIds,
          postActionWindow: window,
          requiredAssetIds: [...new Set(requiredSignals.map((r) => r.assetId))],
          requiredSignals,
          startedAt: at,
          startedEventId: envelope.event_id,
          correlationId,
          status: "IN_PROGRESS",
        };

        await deps.verifications.save(attempt);
        await deps.riskEvents.save(coordinated.value.event);
        await deps.cases.save(coordinated.value.case);
        await deps.audit.append({
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          caseId: c.caseId,
          actorId: "SYSTEM-VERIFICATION",
          actorType: "SYSTEM",
          action: "VERIFICATION_STARTED",
          targetType: "VERIFICATION",
          targetId: verificationId,
          beforeState: c.state,
          afterState: coordinated.value.case.state,
          correlationId,
          at,
          details: {
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            windowStart: window.start,
            windowEnd: window.end,
            actionIds: attempt.actionIds,
          },
        });
        await deps.bus.publish(envelope);
        await deps.bus.publish(
          createEnvelope(deps.ids, {
            ...startedBase(c, correlationId, envelope.event_id),
            type: "case.updated.v1",
            payload: {
              caseId: c.caseId,
              riskEventId: event.eventId,
              change: "VERIFICATION_STARTED" as const,
              state: coordinated.value.case.state,
              previousState: c.state,
              severity: c.severity,
              previousSeverity: c.severity,
            },
          }),
        );
        started.push({ caseId: c.caseId, verificationId });
      } catch (error) {
        failures.push({
          caseId: c.caseId,
          code: "PROCESSING_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { started, failures };
  }

  function fallbackAssessment(
    attempt: VerificationAttempt,
    now: string,
    reason: string,
  ): { assessment: VerificationAssessment; evidenceReferences: EvidenceReference[] } {
    const window: TimeWindow = attempt.postActionWindow;
    const before: TimeWindow = {
      start: new Date(Date.parse(window.start) - 1000).toISOString(),
      end: window.start,
    };
    const criterion: CriterionResult = {
      criterionId: "VERIFICATION_PROCESSING",
      passed: false,
      role: "REQUIRED",
      outcome: "INSUFFICIENT",
      reasonCodes: [reason],
    };
    const policyRef = `POLICY:${attempt.policyId}:${attempt.policyVersion}`;
    return {
      assessment: {
        verificationId: attempt.verificationId,
        caseId: attempt.caseId,
        eventId: attempt.eventId,
        policyId: attempt.policyId,
        policyVersion: attempt.policyVersion,
        baselineWindow: before,
        postActionWindow: window,
        requiredCriteria: [criterion],
        supportingCriteria: [],
        dataCompleteness: 0,
        telemetryConfidence: 0,
        deviceHealthStatus: "UNKNOWN",
        authIntegrityStatus: "NO_EVIDENCE",
        result: "INCONCLUSIVE",
        confidence: 0,
        evidenceIds: [policyRef],
        evaluatedAt: now,
        reasonCodes: [reason],
      },
      evidenceReferences: [{ id: policyRef, kind: "POLICY" }],
    };
  }

  async function snapshotBaselines(c: RiskImprovementCase): Promise<Baseline[]> {
    if (c.baselineSnapshotId === undefined) return [];
    const snap = await deps.baselines.getSnapshot(c.organizationId, c.baselineSnapshotId);
    if (snap === undefined) return [];
    const out: Baseline[] = [];
    for (const id of snap.baselineIds) {
      const b = await deps.baselines.getById(c.organizationId, id);
      if (b !== undefined) out.push(b);
    }
    return out;
  }

  async function evaluateDue() {
    const completed: { caseId: string; verificationId: string; result: string }[] = [];
    const failures: VerificationFailure[] = [];

    for (const attempt of await deps.verifications.listAllForSystemTick()) {
      if (attempt.status !== "IN_PROGRESS") continue;
      const nowMs = deps.clock.nowMs();
      if (nowMs < Date.parse(attempt.postActionWindow.end)) continue; // window still open
      try {
        const c = await deps.cases.get(attempt.organizationId, attempt.caseId);
        const event = await deps.riskEvents.get(attempt.organizationId, attempt.eventId);
        if (
          c === undefined ||
          event === undefined ||
          c.state !== "VERIFYING" ||
          event.state !== "VERIFYING" ||
          c.activeRiskEventId !== event.eventId
        ) {
          failures.push({
            caseId: attempt.caseId,
            verificationId: attempt.verificationId,
            code: "STATE_MISMATCH",
            message: "Case or risk event is not in VERIFYING for this attempt",
          });
          continue;
        }
        const now = nowIso(deps.clock);
        const trail = await deps.audit.listByCase(c.organizationId, c.caseId);
        const auditEvidenceIds = trail
          .filter(
            (e: AuditEntry) =>
              (e.action === "ACTION_REPORTED" && attempt.actionIds.includes(e.targetId)) ||
              (e.action === "VERIFICATION_STARTED" && e.targetId === attempt.verificationId),
          )
          .map((e) => e.auditId);
        const cycleActions: MitigationAction[] = (
          await deps.actions.listByCase(c.organizationId, c.caseId)
        ).filter((a) => attempt.actionIds.includes(a.actionId));
        const reportedAt = laterIso(
          ...cycleActions.map((a) => a.reportedAt ?? attempt.startedAt),
          attempt.startedAt,
        );

        let policy: VerificationPolicy | undefined;
        let evaluated: ReturnType<typeof evaluateVerification> | undefined;
        let processingError: string | undefined;
        let deviceSnapshots: DeviceFactSnapshot[] = [];
        try {
          policy = await policyForAttempt(attempt);
          const baselineConfig = await resolveValue(
            deps.baselineConfig,
            c.organizationId,
            c.facilityId,
          );
          const lookbackMs = policy.reference.preActionLookbackSeconds * 1000;
          const observations = await deps.observations.listForWindow({
            organizationId: c.organizationId,
            facilityId: c.facilityId,
            assetIds: attempt.requiredAssetIds.length > 0 ? attempt.requiredAssetIds : c.assetIds,
            fromIso: new Date(Date.parse(reportedAt) - lookbackMs).toISOString(),
            toIso: attempt.postActionWindow.end,
          });
          const devices = await deviceFacts(c, now);
          deviceSnapshots = devices.snapshots;
          evaluated = evaluateVerification({
            verificationId: attempt.verificationId,
            policy,
            baselineConfig,
            caseRecord: c,
            event,
            actions: cycleActions,
            actionReportedAt: reportedAt,
            window: attempt.postActionWindow,
            now,
            observations,
            snapshotBaselines: await snapshotBaselines(c),
            activeBaselines: [...(await deps.baselines.listActive(c.organizationId, c.facilityId))],
            devices: devices.facts,
            auditEvidenceIds,
          });
        } catch (error) {
          processingError = error instanceof Error ? error.message : String(error);
        }

        let assessment: VerificationAssessment;
        let evidenceReferences: readonly EvidenceReference[];
        let recurrenceWatchEndsAt: string | undefined;
        if (evaluated === undefined) {
          // Processing failure => explicit INCONCLUSIVE, never VERIFIED.
          ({ assessment, evidenceReferences } = fallbackAssessment(
            attempt,
            now,
            "VERIFICATION_PROCESSING_FAILURE",
          ));
          failures.push({
            caseId: c.caseId,
            verificationId: attempt.verificationId,
            code: "PROCESSING_FAILURE",
            message: processingError ?? "evaluation failed",
          });
        } else if (!evaluated.complete) {
          continue;
        } else {
          ({ assessment, evidenceReferences } = evaluated);
          recurrenceWatchEndsAt = evaluated.recurrenceWatchEndsAt;
        }

        const at = laterIso(now, c.updatedAt, event.updatedAt);
        const coordinated = completeVerification({ case: c, event, assessment, at });
        if (!coordinated.ok) {
          failures.push({
            caseId: c.caseId,
            verificationId: attempt.verificationId,
            code: "COMPLETE_REJECTED",
            message: coordinated.error.message,
            domain: coordinated.error,
          });
          continue;
        }

        const done: VerificationAttempt = {
          ...attempt,
          status: "COMPLETED",
          evaluatedAt: assessment.evaluatedAt,
          assessment,
          evidenceReferences,
          deviceSnapshots,
          ...(recurrenceWatchEndsAt !== undefined &&
            assessment.result === "VERIFIED" && { recurrenceWatchEndsAt }),
        };
        await deps.verifications.save(done);
        await deps.riskEvents.save(coordinated.value.event);
        await deps.cases.save(coordinated.value.case);
        await deps.audit.append({
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          caseId: c.caseId,
          actorId: "SYSTEM-VERIFICATION",
          actorType: "SYSTEM",
          action: "VERIFICATION_COMPLETED",
          targetType: "VERIFICATION",
          targetId: attempt.verificationId,
          beforeState: "VERIFYING",
          afterState: coordinated.value.case.state,
          correlationId: attempt.correlationId,
          at,
          details: {
            result: assessment.result,
            confidence: assessment.confidence,
            completeness: assessment.dataCompleteness,
            evidenceCount: assessment.evidenceIds.length,
            reasonCodes: assessment.reasonCodes ?? [],
          },
        });
        const completedEvent = createEnvelope(deps.ids, {
          ...startedBase(c, attempt.correlationId, attempt.startedEventId ?? null),
          type: "verification.completed.v1",
          payload: {
            verificationId: attempt.verificationId,
            caseId: c.caseId,
            riskEventId: event.eventId,
            policyId: assessment.policyId,
            policyVersion: assessment.policyVersion,
            result: assessment.result,
            confidence: assessment.confidence,
            completeness: assessment.dataCompleteness,
            telemetryConfidence: assessment.telemetryConfidence,
            reasonCodes: assessment.reasonCodes ?? [],
            evidenceIds: assessment.evidenceIds,
            evaluatedAt: assessment.evaluatedAt,
          },
        });
        await deps.bus.publish(completedEvent);
        await deps.bus.publish(
          createEnvelope(deps.ids, {
            ...startedBase(c, attempt.correlationId, completedEvent.event_id),
            type: "case.updated.v1",
            payload: {
              caseId: c.caseId,
              riskEventId: event.eventId,
              change: "VERIFICATION_COMPLETED" as const,
              state: coordinated.value.case.state,
              previousState: c.state,
              severity: c.severity,
              previousSeverity: c.severity,
            },
          }),
        );
        completed.push({
          caseId: c.caseId,
          verificationId: attempt.verificationId,
          result: assessment.result,
        });
      } catch (error) {
        failures.push({
          caseId: attempt.caseId,
          verificationId: attempt.verificationId,
          code: "PROCESSING_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { completed, failures };
  }

  return {
    startDue,
    evaluateDue,
    async tick() {
      const s = await startDue();
      const e = await evaluateDue();
      return {
        started: s.started,
        completed: e.completed,
        failures: [...s.failures, ...e.failures],
      };
    },
  };
}

export type EvidenceResolution = {
  readonly id: string;
  readonly kind: EvidenceReference["kind"];
  readonly exists: boolean;
};

/**
 * Proves that every evidence reference of a completed verification names a real record. S6 will
 * build immutable packages from the same references; this check is what keeps them honest.
 */
export async function resolveEvidence(
  deps: Pick<
    VerificationRunnerDeps,
    "observations" | "baselines" | "actions" | "audit" | "registry"
  > & {
    readonly knownPolicies:
      | readonly { policyId: string; policyVersion: string }[]
      | ((
          attempt: VerificationAttempt,
        ) =>
          | readonly { policyId: string; policyVersion: string }[]
          | Promise<readonly { policyId: string; policyVersion: string }[]>);
  },
  attempt: VerificationAttempt,
): Promise<readonly EvidenceResolution[]> {
  const org = attempt.organizationId;
  const trail = await deps.audit.listByCase(org, attempt.caseId);
  const knownPolicies =
    typeof deps.knownPolicies === "function" ? await deps.knownPolicies(attempt) : deps.knownPolicies;
  const out: EvidenceResolution[] = [];
  for (const ref of attempt.evidenceReferences ?? []) {
    let exists = false;
    switch (ref.kind) {
      case "OBSERVATION":
        exists = (await deps.observations.get(org, ref.id)) !== undefined;
        break;
      case "BASELINE":
        exists = (await deps.baselines.getById(org, ref.id)) !== undefined;
        break;
      case "ACTION":
        exists = (await deps.actions.get(org, ref.id)) !== undefined;
        break;
      case "AUDIT":
        exists = trail.some((e) => e.auditId === ref.id);
        break;
      case "POLICY":
        exists = knownPolicies.some(
          (p) => `POLICY:${p.policyId}:${p.policyVersion}` === ref.id,
        );
        break;
      case "DEVICE": {
        // The frozen copy taken at verification time wins; the live registry is only a fallback
        // for attempts completed before snapshots existed.
        const deviceId = ref.id.replace(/^DEVICE:/, "");
        if (attempt.deviceSnapshots !== undefined) {
          exists = attempt.deviceSnapshots.some(
            (d) => d.deviceId === deviceId && d.organizationId === org,
          );
        } else {
          const device = await deps.registry.get(deviceId);
          exists = device !== undefined && device.organizationId === org;
        }
        break;
      }
    }
    out.push({ id: ref.id, kind: ref.kind, exists });
  }
  return out;
}
