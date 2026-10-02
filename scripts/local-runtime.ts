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
import {
  InMemoryDeviceRegistry,
  SYNTHETIC_DEV_DEVICE,
  createSyntheticDevRegistry,
} from "@symbiosis/device-registry";
import type { DeviceRegistry, DeviceKeyStore } from "@symbiosis/device-registry";
import { EmailNotificationSender } from "@symbiosis/adapter-email";
import type { EmailTransport } from "@symbiosis/adapter-email";
import type { WeatherProvider } from "@symbiosis/contracts";
import { StoreContactDirectory } from "@symbiosis/notifications";
import type { EdgeSubmit } from "@symbiosis/simulation";
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
  InMemoryTenantDocumentStore,
  InMemorySharingAgreementRepository,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import type { RuleConfig } from "@symbiosis/risk-detection";
import type { FacilityPurgeable } from "@symbiosis/repositories";
import type { EvidenceResolution, VerificationRunner } from "@symbiosis/worker";
import {
  composeServices,
  createSimulationHttp,
  loadAdapterProfiles,
  loadFollowUpPolicy,
  loadPolicyParameters,
  loadRawPolicyBase,
  loadScenarios,
  loadSimulationFacility,
  simulationDeviceRecords,
  syntheticSimulationKeys,
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
  /**
   * S10: sends alert email through this transport (tests and demos inject the in-memory provider)
   * instead of the console channel. Contacts for the synthetic actors use `.example` addresses.
   */
  readonly emailTransport?: EmailTransport;
  /** S10: live weather provider. Absent: live weather is NOT_CONFIGURED (it never falls back). */
  readonly weatherProvider?: WeatherProvider;
  /** S10: set false to build the runtime without the Facility Simulation. Default: enabled. */
  readonly simulation?: boolean;
  /** S10: base URL used for the case link in emails. */
  readonly webBaseUrl?: string;
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
  /** The composed services (S10: adapter catalog, follow-ups, simulation, deliveries, contacts). */
  readonly services: ReturnType<typeof composeServices>;
  /** S10: the simulation emission engine (undefined when the simulation is disabled). */
  readonly engine: ReturnType<typeof createSimulationHttp>["engine"];
  /** The edge boundary, for tests that send signed requests directly. */
  readonly edge: ReturnType<typeof createEdgeHandler>;
  readonly documents: InMemoryTenantDocumentStore;
  close(): Promise<void>;
};

/** Looks a key up in several stores, first hit wins. */
class CompositeKeyStore implements DeviceKeyStore {
  constructor(private readonly stores: readonly DeviceKeyStore[]) {}
  async getKey(deviceId: string, keyId: string) {
    for (const store of this.stores) {
      const k = await store.getKey(deviceId, keyId);
      if (k !== undefined) return k;
    }
    return undefined;
  }
}

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
  const documents = new InMemoryTenantDocumentStore();
  const emailTransport = options.emailTransport;
  const directory = createSyntheticActorDirectory();
  const organizations = createSyntheticOrganizationDirectory();
  const verificationPolicy = options.verificationPolicy ?? loadVerificationPolicy();
  const synthetic = createSyntheticDevRegistry();
  const facilityModel = options.simulation === false ? undefined : loadSimulationFacility();
  const registry =
    facilityModel === undefined
      ? synthetic.registry
      : new InMemoryDeviceRegistry([SYNTHETIC_DEV_DEVICE, ...simulationDeviceRecords(facilityModel)]);
  const keys: DeviceKeyStore =
    facilityModel === undefined
      ? synthetic.keys
      : new CompositeKeyStore([synthetic.keys, syntheticSimulationKeys(facilityModel)]);
  const contactDirectory = new StoreContactDirectory(documents);
  if (options.emailTransport !== undefined) {
    // Synthetic recipients: `.example` is reserved and can never be delivered.
    for (const a of SYNTHETIC_ACTORS) {
      await contactDirectory.put({
        actorId: a.actorId,
        organizationId: a.organizationId,
        email: `${a.actorId.toLowerCase()}@symbiosis-demo.example`,
        enabled: true,
        categories: ["INITIAL", "ESCALATION", "FOLLOW_UP"],
        updatedAt: new Date(clock.nowMs()).toISOString(),
        updatedBy: "SYSTEM",
      });
    }
  }
  const purge = async (scope: { organizationId: string; facilityId: string }) => {
    const caseIds = new Set(
      (await cases.listAllForSystemTick())
        .filter((c) => c.organizationId === scope.organizationId && c.facilityId === scope.facilityId)
        .map((c) => c.caseId),
    );
    const removed: Record<string, number> = {};
    const run = async (name: string, repo: FacilityPurgeable) => {
      removed[name] = await repo.purgeFacility(scope.organizationId, scope.facilityId, caseIds);
    };
    await run("observations", observations);
    await run("baselines", baselines);
    await run("detectionStates", detectionStates);
    await run("cases", cases);
    await run("riskEvents", riskEvents);
    await run("alerts", alerts);
    await run("actions", actions);
    await run("verifications", verifications);
    await run("interventions", interventions);
    await run("evidencePackages", evidencePackages);
    await run("sharingAgreements", agreements);
    await run("sharedEvidence", shares);
    return removed;
  };

  const portsForHttp = {
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
    documents,
  };
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
      documents,
    },
    {
      clock,
      ids,
      notificationSender:
        options.notificationSender ??
        (emailTransport !== undefined
          ? new EmailNotificationSender({
              clock,
              contacts: contactDirectory,
              transport: emailTransport,
              from: () => "alerts@symbiosis-demo.example",
              fromName: "Symbiosis AI",
            })
          : new ConsoleEmail(clock, options.consoleSink)),
      adapterProfiles: loadAdapterProfiles(),
      ...(options.webBaseUrl !== undefined && { webBaseUrl: options.webBaseUrl }),
      ...(facilityModel !== undefined && {
        simulation: {
          facility: facilityModel,
          scenarios: loadScenarios(),
          parameters: loadPolicyParameters(),
          rawBase: loadRawPolicyBase(),
          weather: {
            policy: { cacheTtlSeconds: 600, failureBackoffSeconds: 120, maxFetchesPerDay: 200, staleAfterSeconds: 3600 },
            ...(options.weatherProvider !== undefined && { live: options.weatherProvider }),
          },
          purge,
        },
      }),
      policies: {
        escalation: options.escalationPolicy ?? loadEscalationPolicy(),
        actionLibrary: options.actionLibrary ?? loadActionLibrary(),
        verification: verificationPolicy,
        intervention: options.interventionPolicy ?? loadInterventionPolicy(),
        baseline: options.baselineConfig ?? loadBaselineConfig(),
        rule: options.ruleConfig ?? loadRuleConfig(),
        dataQuality: loadDataQualityConfig(),
        followUp: loadFollowUpPolicy(),
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
    adapters: services.catalog,
    ...(options.log !== undefined && { log: options.log }),
  });
  // The simulation reaches the platform exactly as a customer's gateway does: signed bytes sent to
  // the edge boundary. Locally that boundary is called in process (no socket needed).
  const submit: EdgeSubmit = async (r) => {
    const res = await edgeHandler({
      method: r.method,
      target: r.target,
      headers: r.headers,
      rawBody: r.rawBody,
    });
    return { status: res.status, body: res.body };
  };
  const http = createSimulationHttp({ services, ports: portsForHttp, clock, ids, submit, tick });
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
      ...(http.simulation !== undefined && { simulation: http.simulation }),
      contacts: http.contacts,
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
    services,
    engine: http.engine,
    edge: edgeHandler,
    documents,
    close: () => server.close(),
  };
}
