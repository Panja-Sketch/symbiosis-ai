import {
  createApiHandler,
  createAppHandler,
  createEdgeHandler,
  createInsuranceHandler,
  createEdgeServer,
  listen,
} from "@symbiosis/api";
import type { RunningServer } from "@symbiosis/api";
import type { EdgeLogEntry } from "@symbiosis/api";
import type { ActionLibrary, Operations } from "@symbiosis/action-orchestration";
import { InMemoryAuditLog } from "@symbiosis/audit";
import type { InsuranceGateway, SharingService } from "@symbiosis/consent";
import {
  ExplanationService,
  InMemoryExplanationLog,
  selectProvider,
} from "@symbiosis/ai-explanation";
import type { ExplanationProvider } from "@symbiosis/ai-explanation";
import { SystemClock } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { BaselineConfig } from "@symbiosis/baselines";
import { InMemoryEvidenceObjectStore } from "@symbiosis/evidence";
import type { EvidenceObjectStore, EvidenceService } from "@symbiosis/evidence";
import type {
  InterventionPolicy,
  InterventionService,
} from "@symbiosis/intervention-prioritization";
import type { VerificationPolicy } from "@symbiosis/verification";
import { createSyntheticDevRegistry } from "@symbiosis/device-registry";
import type { DeviceRegistry, DeviceKeyStore } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import type { EscalationPolicy } from "@symbiosis/escalation";
import { InMemoryBus, RandomIdGenerator } from "@symbiosis/event-bus";
import type { IdGenerator } from "@symbiosis/event-bus";
import { ConsoleEmail } from "@symbiosis/notifications";
import type { NotificationSender } from "@symbiosis/notifications";
import {
  SYNTHETIC_ACTORS,
  SYNTHETIC_ORGANIZATIONS,
  createSyntheticActorDirectory,
  createSyntheticOrganizationDirectory,
} from "@symbiosis/tenancy";
import {
  InMemoryActionRepository,
  InMemoryAlertRepository,
  InMemoryBaselineRepository,
  InMemoryCaseRepository,
  InMemoryDetectionStateRepository,
  InMemoryEvidencePackageRepository,
  InMemoryInterventionRepository,
  InMemoryObservationRepository,
  InMemoryRiskEventRepository,
  InMemorySharedEvidenceRepository,
  InMemorySharingAgreementRepository,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import type { RuleConfig } from "@symbiosis/risk-detection";
import type { EvidenceResolution, VerificationRunner } from "@symbiosis/worker";
import {
  composeServices,
  loadActionLibrary,
  loadBaselineConfig,
  loadDataQualityConfig,
  loadEscalationPolicy,
  loadExplanationConfig,
  loadInterventionPolicy,
  loadRuleConfig,
  loadVerificationPolicy,
} from "@symbiosis/runtime";

export {
  loadActionLibrary,
  loadBaselineConfig,
  loadDataQualityConfig,
  loadEscalationPolicy,
  loadExplanationConfig,
  loadInterventionPolicy,
  loadRuleConfig,
  loadVerificationPolicy,
};

/**
 * Local-mode composition root (spec section 39). In the cloud, `api` and `worker` are separate
 * Cloud Run deployables joined by Pub/Sub. Locally they share one process joined by the
 * InMemoryBus. All business logic stays in the packages; this file only wires them.
 */
export type LocalRuntimeOptions = {
  readonly port?: number;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly log?: (entry: EdgeLogEntry) => void;
  /** Overrides for scenarios/tests; defaults are the versioned files in config/rules/. */
  readonly baselineConfig?: BaselineConfig;
  readonly ruleConfig?: RuleConfig;
  readonly escalationPolicy?: EscalationPolicy;
  readonly actionLibrary?: ActionLibrary;
  readonly verificationPolicy?: VerificationPolicy;
  readonly interventionPolicy?: InterventionPolicy;
  /** Replaces ConsoleEmail (tests inject a scripted sender). */
  readonly notificationSender?: NotificationSender;
  /** Where ConsoleEmail writes; defaults to console.log. */
  readonly consoleSink?: (line: string) => void;
  /** Replaces the in-memory evidence object store (tests inject a failing or tamperable one). */
  readonly evidenceStore?: EvidenceObjectStore;
  /** Replaces the configured primary explanation provider (tests inject fakes). The template stays the fallback. */
  readonly explanationProvider?: ExplanationProvider;
  /** Environment used for explanation settings; defaults to process.env. */
  readonly explanationEnv?: Readonly<Record<string, string | undefined>>;
};

export type LocalRuntime = {
  readonly server: RunningServer;
  readonly bus: InMemoryBus;
  readonly observations: InMemoryObservationRepository;
  readonly baselines: InMemoryBaselineRepository;
  readonly detectionStates: InMemoryDetectionStateRepository;
  readonly cases: InMemoryCaseRepository;
  readonly riskEvents: InMemoryRiskEventRepository;
  readonly alerts: InMemoryAlertRepository;
  readonly actions: InMemoryActionRepository;
  readonly verifications: InMemoryVerificationRepository;
  readonly interventions: InMemoryInterventionRepository;
  readonly evidencePackages: InMemoryEvidencePackageRepository;
  readonly evidenceStore: EvidenceObjectStore;
  readonly agreements: InMemorySharingAgreementRepository;
  readonly shares: InMemorySharedEvidenceRepository;
  readonly evidenceService: EvidenceService;
  readonly explanations: ExplanationService;
  readonly explanationLog: InMemoryExplanationLog;
  readonly sharingService: SharingService;
  readonly insuranceGateway: InsuranceGateway;
  readonly verificationRunner: VerificationRunner;
  readonly interventionService: InterventionService;
  readonly verificationPolicy: VerificationPolicy;
  /** Proves each evidence reference of a verification names a real stored record. */
  resolveEvidence(
    verificationId: string,
    organizationId: string,
  ): Promise<readonly EvidenceResolution[]>;
  readonly audit: InMemoryAuditLog;
  readonly operations: Operations;
  readonly directory: ReturnType<typeof createSyntheticActorDirectory>;
  /** One scheduler pass: alert retries, escalation, then verification start/evaluation. */
  tick(): Promise<{
    escalated: readonly { riskEventId: string; caseId: string }[];
    retried: number;
    verification: Awaited<ReturnType<VerificationRunner["tick"]>>;
    evidence: Awaited<ReturnType<EvidenceService["createMissing"]>>;
    sharing: Awaited<ReturnType<SharingService["reconcileAll"]>>;
  }>;
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly clock: Clock;
  close(): Promise<void>;
};

export async function createLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new RandomIdGenerator();
  const bus = new InMemoryBus();
  const observations = new InMemoryObservationRepository();
  const baselines = new InMemoryBaselineRepository();
  const detectionStates = new InMemoryDetectionStateRepository();
  const cases = new InMemoryCaseRepository();
  const riskEvents = new InMemoryRiskEventRepository();
  const alerts = new InMemoryAlertRepository();
  const actions = new InMemoryActionRepository();
  const verifications = new InMemoryVerificationRepository();
  const interventions = new InMemoryInterventionRepository();
  const evidencePackages = new InMemoryEvidencePackageRepository();
  const evidenceStore = options.evidenceStore ?? new InMemoryEvidenceObjectStore();
  const agreements = new InMemorySharingAgreementRepository();
  const shares = new InMemorySharedEvidenceRepository();
  const audit = new InMemoryAuditLog();
  const directory = createSyntheticActorDirectory();
  const organizations = createSyntheticOrganizationDirectory();
  const verificationPolicy = options.verificationPolicy ?? loadVerificationPolicy();
  const { registry, keys } = createSyntheticDevRegistry();

  const services = composeServices(
    {
      bus,
      observations,
      baselines,
      detectionStates,
      cases,
      riskEvents,
      alerts,
      actions,
      verifications,
      interventions,
      evidencePackages,
      agreements,
      shares,
      evidenceStore,
      audit,
      directory,
      organizations,
      registry,
      keys,
      replayGuard: new InMemoryReplayGuard(),
    },
    {
      clock,
      ids,
      notificationSender:
        options.notificationSender ?? new ConsoleEmail(clock, options.consoleSink),
      policies: {
        escalation: options.escalationPolicy ?? loadEscalationPolicy(),
        actionLibrary: options.actionLibrary ?? loadActionLibrary(),
        verification: verificationPolicy,
        intervention: options.interventionPolicy ?? loadInterventionPolicy(),
        baseline: options.baselineConfig ?? loadBaselineConfig(),
        rule: options.ruleConfig ?? loadRuleConfig(),
        dataQuality: loadDataQualityConfig(),
      },
    },
  );
  // Local mode is one process: the API and every consumer share the in-memory bus.
  services.startConsumers();
  const { operations, interventionService, evidenceService, sharingService, insuranceGateway } =
    services;
  const { verificationRunner, tick } = services;

  const edgeHandler = createEdgeHandler({
    registry,
    keys,
    replayGuard: new InMemoryReplayGuard(),
    bus,
    clock,
    ids,
    ...(options.log !== undefined && { log: options.log }),
  });
  const explanationEnv = options.explanationEnv ?? process.env;
  const explanationConfig = loadExplanationConfig(explanationEnv);
  const chosen = selectProvider(explanationConfig, explanationEnv);
  const explanationLog = new InMemoryExplanationLog();
  const explanations = new ExplanationService({
    primary: options.explanationProvider ?? chosen.primary,
    fallback: chosen.fallback,
    clock,
    ids,
    log: explanationLog,
    ...(chosen.note !== undefined &&
      options.explanationProvider === undefined && { primaryNote: chosen.note }),
    settings: {
      promptVersion: explanationConfig.promptVersion,
      schemaVersion: explanationConfig.outputSchemaVersion,
      timeoutMs: explanationConfig.gemini.timeoutMs,
      cacheTtlMs: explanationConfig.cache.ttlSeconds * 1000,
      fallbackCacheTtlMs: explanationConfig.cache.fallbackTtlSeconds * 1000,
    },
  });
  const handler = createApiHandler({
    edge: edgeHandler,
    app: createAppHandler({
      operations,
      interventions: interventionService,
      evidence: evidenceService,
      sharing: sharingService,
      insurance: insuranceGateway,
      directory,
      runTick: tick,
      explanations,
      devIdentities: { actors: SYNTHETIC_ACTORS, organizations: SYNTHETIC_ORGANIZATIONS },
    }),
    insurance: createInsuranceHandler({ gateway: insuranceGateway, directory, explanations }),
  });
  const server = await listen(createEdgeServer(handler), options.port ?? 0);
  return {
    server,
    bus,
    observations,
    baselines,
    detectionStates,
    cases,
    riskEvents,
    alerts,
    actions,
    verifications,
    interventions,
    evidencePackages,
    evidenceStore,
    agreements,
    shares,
    evidenceService,
    explanations,
    explanationLog,
    sharingService,
    insuranceGateway,
    verificationRunner,
    interventionService,
    verificationPolicy,
    resolveEvidence: services.resolveEvidence,
    audit,
    operations,
    directory,
    tick,
    registry,
    keys,
    clock,
    close: () => server.close(),
  };
}
