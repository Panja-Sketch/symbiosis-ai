import { actionsFor, createOperations } from "@symbiosis/action-orchestration";
import type { ActionLibrary, Operations } from "@symbiosis/action-orchestration";
import { simulatorSourceAdapter } from "@symbiosis/adapter-simulator";
import type { AuditLog } from "@symbiosis/audit";
import type { BaselineConfig } from "@symbiosis/baselines";
import { createInsuranceGateway, createSharingService, startSharing } from "@symbiosis/consent";
import type { InsuranceGateway, SharingService } from "@symbiosis/consent";
import type { Clock } from "@symbiosis/clock";
import { edgeDeviceSourceAdapter } from "@symbiosis/normalization";
import type { DataQualityConfig } from "@symbiosis/data-quality";
import type { DeviceKeyStore, DeviceRegistry } from "@symbiosis/device-registry";
import type { ReplayGuard } from "@symbiosis/edge-security";
import { runEscalationTick } from "@symbiosis/escalation";
import type { EscalationPolicy } from "@symbiosis/escalation";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";
import { createEvidenceService, startEvidenceBuilder } from "@symbiosis/evidence";
import type { EvidenceObjectStore, EvidenceService } from "@symbiosis/evidence";
import {
  createInterventionService,
  startInterventions,
} from "@symbiosis/intervention-prioritization";
import type {
  InterventionPolicy,
  InterventionService,
} from "@symbiosis/intervention-prioritization";
import { createAlerting, startAlerting } from "@symbiosis/notifications";
import type { NotificationSender } from "@symbiosis/notifications";
import type {
  EvidencePackageRepository,
  ActionRepository,
  AlertRepository,
  BaselineRepository,
  CaseRepository,
  DetectionStateRepository,
  InterventionRepository,
  ObservationRepository,
  RiskEventRepository,
  SharedEvidenceRepository,
  SharingAgreementRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import type { RuleConfig } from "@symbiosis/risk-detection";
import type { ActorDirectory, OrganizationDirectory } from "@symbiosis/tenancy";
import type { VerificationPolicy } from "@symbiosis/verification";
import {
  createVerificationRunner,
  resolveEvidence,
  startRiskPipeline,
  startTelemetryWorker,
} from "@symbiosis/worker";
import type { EvidenceResolution, VerificationRunner } from "@symbiosis/worker";

/**
 * Everything the platform needs from infrastructure. Local mode supplies in-memory
 * implementations; the gcp runtime supplies Firestore, Pub/Sub, Cloud Storage and Secret Manager
 * ones. The services below are identical in both: S9 changes adapters, never domain behavior.
 */
export type Ports = {
  readonly bus: EventBus;
  readonly observations: ObservationRepository;
  readonly baselines: BaselineRepository;
  readonly detectionStates: DetectionStateRepository;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly alerts: AlertRepository;
  readonly actions: ActionRepository;
  readonly verifications: VerificationRepository;
  readonly interventions: InterventionRepository;
  readonly evidencePackages: EvidencePackageRepository;
  readonly agreements: SharingAgreementRepository;
  readonly shares: SharedEvidenceRepository;
  readonly evidenceStore: EvidenceObjectStore;
  readonly audit: AuditLog;
  readonly directory: ActorDirectory;
  readonly organizations: OrganizationDirectory;
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly replayGuard: ReplayGuard;
};

export type Policies = {
  readonly escalation: EscalationPolicy;
  readonly actionLibrary: ActionLibrary;
  readonly verification: VerificationPolicy;
  readonly intervention: InterventionPolicy;
  readonly baseline: BaselineConfig;
  readonly rule: RuleConfig;
  readonly dataQuality: DataQualityConfig;
};

export type ComposeOptions = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policies: Policies;
  readonly notificationSender: NotificationSender;
};

export type Services = {
  readonly operations: Operations;
  readonly interventionService: InterventionService;
  readonly evidenceService: EvidenceService;
  readonly sharingService: SharingService;
  readonly insuranceGateway: InsuranceGateway;
  readonly verificationRunner: VerificationRunner;
  /**
   * Registers every event consumer on the bus (telemetry worker, risk pipeline, interventions,
   * evidence builder, sharing, alerting). The API role never calls this; the worker role does, and
   * the local runtime does for its single combined process.
   */
  startConsumers(): void;
  resolveEvidence(
    verificationId: string,
    organizationId: string,
  ): Promise<readonly EvidenceResolution[]>;
  /** One scheduler pass: alert retries, escalation, verification, evidence, sharing reconciliation. */
  tick(): Promise<{
    escalated: readonly { riskEventId: string; caseId: string }[];
    retried: number;
    verification: Awaited<ReturnType<VerificationRunner["tick"]>>;
    evidence: Awaited<ReturnType<EvidenceService["createMissing"]>>;
    sharing: Awaited<ReturnType<SharingService["reconcileAll"]>>;
  }>;
};

export function composeServices(ports: Ports, options: ComposeOptions): Services {
  const { clock, ids, policies } = options;
  const { bus, audit, cases, riskEvents, actions, observations, baselines, verifications } = ports;

  const interventionDeps = {
    bus,
    ids,
    clock,
    audit,
    cases,
    verifications,
    interventions: ports.interventions,
    policy: policies.intervention,
  };
  const interventionService = createInterventionService(interventionDeps);

  const verificationRunner = createVerificationRunner({
    bus,
    ids,
    clock,
    audit,
    cases,
    riskEvents,
    actions,
    observations,
    baselines,
    verifications,
    registry: ports.registry,
    policy: policies.verification,
    baselineConfig: policies.baseline,
  });

  // Evidence (S6): a package is built from every completed verification, then the consent
  // service reacts to the package. Neither can change a verification result or a risk state.
  const evidenceService = createEvidenceService({
    bus,
    ids,
    clock,
    audit,
    cases,
    riskEvents,
    actions,
    observations,
    baselines,
    verifications,
    packages: ports.evidencePackages,
    store: ports.evidenceStore,
    policies: [
      {
        policyId: policies.verification.policyId,
        policyVersion: policies.verification.policyVersion,
        document: policies.verification,
      },
    ],
    approvedActionsFor: (hazardType) =>
      actionsFor(policies.actionLibrary, hazardType).map((a) => ({
        actionLibraryId: a.actionLibraryId,
        title: a.title,
        libraryVersion: policies.actionLibrary.version,
      })),
  });
  const sharingService = createSharingService({
    bus,
    ids,
    clock,
    audit,
    cases,
    agreements: ports.agreements,
    shares: ports.shares,
    packages: ports.evidencePackages,
    organizations: ports.organizations,
  });
  const insuranceGateway = createInsuranceGateway({
    ids,
    clock,
    audit,
    cases,
    agreements: ports.agreements,
    packages: ports.evidencePackages,
    interventions: ports.interventions,
    evidence: evidenceService,
  });

  const alertingDeps = {
    bus,
    ids,
    clock,
    alerts: ports.alerts,
    cases,
    riskEvents,
    audit,
    directory: ports.directory,
    sender: options.notificationSender,
    policy: policies.escalation,
  };
  const alerting = createAlerting(alertingDeps);
  const operations = createOperations({
    cases,
    riskEvents,
    actions,
    alerts: ports.alerts,
    verifications,
    interventions: ports.interventions,
    audit,
    bus,
    ids,
    clock,
    library: policies.actionLibrary,
    directory: ports.directory,
  });

  const startConsumers = () => {
    startTelemetryWorker({
      bus,
      adapters: { HARDWARE: edgeDeviceSourceAdapter, SIMULATOR: simulatorSourceAdapter },
      quality: policies.dataQuality,
      observations,
      ids,
      clock,
    });
    startRiskPipeline({
      bus,
      ids,
      clock,
      baselines,
      detectionStates: ports.detectionStates,
      cases,
      riskEvents,
      verifications,
      audit,
      rule: policies.rule,
      baselineConfig: policies.baseline,
    });
    startInterventions(interventionDeps, interventionService);
    startEvidenceBuilder({ bus }, evidenceService);
    startSharing({ bus }, sharingService);
    startAlerting(alertingDeps, alerting);
  };

  // One scheduler-style pass. Retries run first so an alert that has just become exhausted is
  // escalated in the same tick instead of waiting for the next one.
  const tick: Services["tick"] = async () => {
    const retried = await alerting.retryDueAlerts();
    const escalation = await runEscalationTick({
      alerts: ports.alerts,
      cases,
      riskEvents,
      audit,
      bus,
      ids,
      clock,
      policy: policies.escalation,
      requestEscalationAlert: async ({ caseRecord, event, correlationId }) => {
        await alerting.requestAlert({
          caseRecord,
          event,
          kind: "ESCALATION",
          correlationId,
          causationId: null,
        });
      },
    });
    // Verification starts for reported actions and completes once a window has ended. It is the
    // only code that can produce a verification result.
    const verification = await verificationRunner.tick();
    // Packages for any completed verification that has none yet, then expiry-aware sharing state.
    const evidence = await evidenceService.createMissing();
    const sharing = await sharingService.reconcileAll();
    return { escalated: escalation.escalated, retried, verification, evidence, sharing };
  };

  return {
    operations,
    interventionService,
    evidenceService,
    sharingService,
    insuranceGateway,
    verificationRunner,
    startConsumers,
    tick,
    resolveEvidence: async (verificationId, organizationId) => {
      const attempt = await verifications.get(organizationId, verificationId);
      if (attempt === undefined) return [];
      return resolveEvidence(
        {
          observations,
          baselines,
          actions,
          audit,
          registry: ports.registry,
          knownPolicies: [policies.verification],
        },
        attempt,
      );
    },
  };
}
