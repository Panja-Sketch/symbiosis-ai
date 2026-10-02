import { actionsFor, createOperations } from "@symbiosis/action-orchestration";
import type { ActionLibrary, Operations } from "@symbiosis/action-orchestration";
import { simulatorSourceAdapter } from "@symbiosis/adapter-simulator";
import {
  SimulatedWeatherProvider,
  createWeatherService,
} from "@symbiosis/adapter-weather";
import type { WeatherPolicy, WeatherService } from "@symbiosis/adapter-weather";
import type {
  SourceMappingDefinition,
  VerificationAttempt,
  WeatherProvider,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import type { BaselineConfig } from "@symbiosis/baselines";
import { createInsuranceGateway, createSharingService, startSharing } from "@symbiosis/consent";
import type { InsuranceGateway, SharingService } from "@symbiosis/consent";
import type { Clock } from "@symbiosis/clock";
import {
  createAdapterCatalog,
  createEdgeV1Adapter,
  edgeDeviceSourceAdapter,
} from "@symbiosis/normalization";
import type { AdapterCatalog } from "@symbiosis/normalization";
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
import {
  StoreContactDirectory,
  StoreDeliveryStore,
  createAlerting,
  createFollowUps,
  describeReasonCodes,
  startAlerting,
  startFollowUps,
} from "@symbiosis/notifications";
import type {
  AlertContextProvider,
  ContactDirectory,
  DeliveryStore,
  FollowUpPolicy,
  FollowUps,
  NotificationSender,
} from "@symbiosis/notifications";
import {
  createSimulationControl,
  createSimulationEngine,
} from "@symbiosis/simulation";
import type {
  EdgeSubmit,
  FacilityModel,
  FacilityResetPort,
  ScenarioDefinition,
  SimulationControl,
  SimulationEngine,
} from "@symbiosis/simulation";
import { RESULT_LABELS } from "@symbiosis/verification";
import type {
  TenantDocumentStore,
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
  startEvaluationRecorder,
  startRiskPipeline,
  startSourceTelemetryWorker,
  startTelemetryWorker,
} from "@symbiosis/worker";
import type { EvidenceResolution, VerificationRunner } from "@symbiosis/worker";
import { createSimulationPolicies } from "./simulation-policy";
import type { PolicyBundle, PolicyParameters, RawPolicyBase, SimulationPolicies } from "./simulation-policy";

/** Observations pulled from the live weather provider: same mapping, a distinct source and name. */
const weatherSourceAdapter = createEdgeV1Adapter({
  adapterName: "weather-google-v1",
  sourceType: "WEATHER_API",
});

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
  /** Control-plane and notification documents (S10): deliveries, contacts, simulation, catalog. */
  readonly documents: TenantDocumentStore;
};

export type Policies = {
  readonly escalation: EscalationPolicy;
  readonly actionLibrary: ActionLibrary;
  readonly verification: VerificationPolicy;
  readonly intervention: InterventionPolicy;
  readonly baseline: BaselineConfig;
  readonly rule: RuleConfig;
  readonly dataQuality: DataQualityConfig;
  readonly followUp: FollowUpPolicy;
};

/**
 * The Facility Simulation (S10). Absent: nothing changes, every tenant resolves the production
 * policies. Present: the ONE simulation tenant and facility resolve their versioned DEMO /
 * SIMULATION POLICY, and the simulation services exist.
 */
export type SimulationOptions = {
  readonly facility: FacilityModel;
  readonly scenarios: readonly ScenarioDefinition[];
  readonly parameters: PolicyParameters;
  readonly rawBase: RawPolicyBase;
  readonly weather: {
    readonly policy: WeatherPolicy;
    /** Absent: live weather reports NOT_CONFIGURED (it never falls back to simulated). */
    readonly live?: WeatherProvider;
  };
  /** Removes the simulation facility's domain records; provided by the composition root. */
  readonly purge: FacilityResetPort["purge"];
};

export type ComposeOptions = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policies: Policies;
  readonly notificationSender: NotificationSender;
  /** Built-in vendor-neutral source-adapter profiles (config/adapters). */
  readonly adapterProfiles?: readonly SourceMappingDefinition[];
  readonly simulation?: SimulationOptions;
  /** Base URL of the web app, for the case link in emails (e.g. https://web.example). Optional. */
  readonly webBaseUrl?: string;
};

export type SimulationServices = {
  readonly facility: FacilityModel;
  readonly scenarios: readonly ScenarioDefinition[];
  readonly policies: SimulationPolicies;
  readonly control: SimulationControl;
  readonly weather: WeatherService;
  /** The emission engine needs the edge boundary, which is built after the services. */
  createEngine(submit: EdgeSubmit): SimulationEngine;
};

export type Services = {
  readonly operations: Operations;
  readonly interventionService: InterventionService;
  readonly evidenceService: EvidenceService;
  readonly sharingService: SharingService;
  readonly insuranceGateway: InsuranceGateway;
  readonly verificationRunner: VerificationRunner;
  /** Versioned source-adapter catalog (D-088); pass it to the edge handler and the worker. */
  readonly catalog: AdapterCatalog;
  readonly contacts: ContactDirectory;
  readonly deliveries: DeliveryStore;
  readonly followUps: FollowUps;
  readonly simulation?: SimulationServices;
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
    followUps: Awaited<ReturnType<FollowUps["tick"]>>;
  }>;
};

export function composeServices(ports: Ports, options: ComposeOptions): Services {
  const { clock, ids, policies } = options;
  const { bus, audit, cases, riskEvents, actions, observations, baselines, verifications } = ports;

  // ---- policy resolution (S10, D-092) ------------------------------------------------------------
  // Every tenant resolves the fixed production policies. The ONE simulation tenant and facility
  // resolve their versioned DEMO / SIMULATION POLICY instead, so a threshold change applies to the
  // next evaluation and production files are never touched.
  const sim = options.simulation;
  const simPolicies: SimulationPolicies | undefined =
    sim === undefined
      ? undefined
      : createSimulationPolicies({
          clock,
          ids,
          store: ports.documents,
          audit,
          organizationId: sim.facility.organizationId,
          facilityId: sim.facility.facilityId,
          parameters: sim.parameters,
          rawBase: sim.rawBase,
        });
  const isSimScope = (org: string, fac: string) =>
    sim !== undefined && org === sim.facility.organizationId && fac === sim.facility.facilityId;
  const pick =
    <K extends keyof Omit<PolicyBundle, "version" | "label">>(key: K, production: PolicyBundle[K]) =>
    async (org: string, fac: string): Promise<PolicyBundle[K]> =>
      simPolicies !== undefined && isSimScope(org, fac)
        ? (await simPolicies.active())[key]
        : production;
  const ruleFor = pick("rule", policies.rule);
  const baselineFor = pick("baseline", policies.baseline);
  const qualityFor = pick("dataQuality", policies.dataQuality);
  const verificationFor = pick("verification", policies.verification);
  const escalationFor = pick("escalation", policies.escalation);
  const followUpFor = pick("followUp", policies.followUp);
  /** The verification policy a given version label names, for attempts that started under it. */
  const verificationByVersion = async (
    org: string,
    fac: string,
    policyId: string,
    policyVersion: string,
  ) => {
    if (simPolicies !== undefined && isSimScope(org, fac) && /^sim\.\d+$/.test(policyVersion)) {
      const b = await simPolicies.bundleFor(Number(policyVersion.slice(4)));
      return b !== undefined && b.verification.policyId === policyId ? b.verification : undefined;
    }
    return policies.verification.policyId === policyId &&
      policies.verification.policyVersion === policyVersion
      ? policies.verification
      : undefined;
  };
  const policiesFor = async (attempt: VerificationAttempt) => {
    const production = {
      policyId: policies.verification.policyId,
      policyVersion: policies.verification.policyVersion,
      document: policies.verification,
    };
    const v = await verificationByVersion(
      attempt.organizationId,
      attempt.facilityId,
      attempt.policyId,
      attempt.policyVersion,
    );
    return v !== undefined && v !== policies.verification
      ? [production, { policyId: v.policyId, policyVersion: v.policyVersion, document: v }]
      : [production];
  };

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
    policy: verificationFor,
    baselineConfig: baselineFor,
    policyByVersion: verificationByVersion,
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
    policies: policiesFor,
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

  // ---- notifications (S10, D-090) ----------------------------------------------------------------
  const deliveries = new StoreDeliveryStore(ports.documents);
  const contacts = new StoreContactDirectory(ports.documents);
  const STATUS_LABELS: Readonly<Record<string, string>> = {
    OPEN: "Risk detected - awaiting acknowledgement",
    ACTION_REQUIRED: "Action required",
    ACTION_REPORTED: "Action reported - verification pending",
    VERIFYING: "Verification in progress",
    VERIFIED_IMPROVED: "Verified improved",
    PARTIALLY_VERIFIED: "Partially verified",
    NOT_IMPROVING: "Not improving - follow-up required",
    INCONCLUSIVE: "Inconclusive - evidence insufficient",
    REOPENED: "Reopened - the risk returned",
    CLOSED: "Closed",
  };
  const CRITERION_NAMES: Readonly<Record<string, string>> = {
    VIBRATION: "Vibration",
    CURRENT: "Electrical current",
    BACKUP_CAPACITY: "Backup cooling running",
    ZONE_TEMPERATURE_SLOPE: "Zone temperature trend",
    DATA_QUALITY: "Data quality",
    DEVICE_INTEGRITY: "Device integrity",
  };
  const alertContext: AlertContextProvider = async ({ caseRecord, alert }) => {
    const simFac =
      sim !== undefined && isSimScope(alert.organizationId, alert.facilityId)
        ? sim.facility
        : undefined;
    const event = await riskEvents.get(alert.organizationId, alert.riskEventId);
    const verificationId =
      alert.trigger !== undefined && alert.trigger.type.startsWith("VERIFICATION_")
        ? alert.trigger.referenceId
        : undefined;
    const attempt =
      verificationId === undefined
        ? undefined
        : await verifications.get(alert.organizationId, verificationId);
    const reported =
      attempt === undefined
        ? []
        : (await actions.listByCase(alert.organizationId, alert.caseId)).filter(
            (a) => attempt.actionIds.includes(a.actionId) && a.reportedAt !== undefined,
          );
    const titleOf = (id: string) =>
      policies.actionLibrary.actions.find((a) => a.actionLibraryId === id)?.title ?? id;
    const webBase = options.webBaseUrl?.replace(/\/+$/, "");
    return {
      ...(simFac !== undefined && {
        facilityName: simFac.name,
        assetNames: Object.fromEntries(simFac.assets.map((a) => [a.assetId, a.name])),
      }),
      ...(webBase !== undefined && {
        caseUrl: `${webBase}/operations/cases/${caseRecord.caseId}`,
      }),
      ...(event !== undefined && { detectedAt: event.detectedAt }),
      approvedActions: actionsFor(policies.actionLibrary, caseRecord.hazardType).map(
        (a) => a.title,
      ),
      statusLabel: STATUS_LABELS[caseRecord.state] ?? caseRecord.state,
      ...(reported.length > 0 && {
        reportedActions: reported.map((a) => ({
          title: titleOf(a.actionLibraryId),
          reportedAt: a.reportedAt as string,
        })),
      }),
      ...(attempt?.assessment !== undefined && {
        verification: {
          verificationId: attempt.verificationId,
          result: attempt.assessment.result,
          resultLabel: RESULT_LABELS[attempt.assessment.result],
          policy: `${attempt.policyId} ${attempt.policyVersion}`,
          completeness: attempt.assessment.dataCompleteness,
          confidence: attempt.assessment.confidence,
          evaluatedAt: attempt.assessment.evaluatedAt,
          criteria: [
            ...attempt.assessment.requiredCriteria,
            ...attempt.assessment.supportingCriteria,
          ].map((k) => ({
            name: CRITERION_NAMES[k.criterionId] ?? k.criterionId,
            outcome: k.outcome ?? (k.passed ? ("PASS" as const) : ("FAIL" as const)),
            required: k.role !== "SUPPORTING",
          })),
        },
      }),
    };
  };
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
    policy: escalationFor,
    deliveries,
    context: alertContext,
  };
  const alerting = createAlerting(alertingDeps);
  const followUps = createFollowUps({
    ids,
    clock,
    audit,
    cases,
    riskEvents,
    actions,
    verifications,
    alerts: ports.alerts,
    alerting,
    store: ports.documents,
    policy: followUpFor,
  });
  const catalog = createAdapterCatalog({
    builtins: options.adapterProfiles ?? [],
    store: ports.documents,
  });
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

  // ---- the Facility Simulation (S10, D-091) -------------------------------------------------------
  let simulation: SimulationServices | undefined;
  if (sim !== undefined && simPolicies !== undefined) {
    const scope = {
      organizationId: sim.facility.organizationId,
      facilityId: sim.facility.facilityId,
    };
    const control = createSimulationControl({
      clock,
      ids,
      store: ports.documents,
      audit,
      facility: sim.facility,
      scenarios: sim.scenarios,
      reset: { purge: sim.purge },
      // Read-only: the primary unit's vibration and current baselines are all READY.
      baselinesReady: async () => {
        const active = await baselines.listActive(scope.organizationId, scope.facilityId);
        const primary = sim.facility.assets.find((a) => a.kind === "COOLING_PRIMARY")?.assetId;
        return ["vibration_rms", "current"].every((signal) => {
          const list = active.filter((b) => b.key.assetId === primary && b.key.signal === signal);
          return list.length > 0 && list.every((b) => b.status === "READY");
        });
      },
    });
    const weather = createWeatherService({
      clock,
      store: ports.documents,
      policy: sim.weather.policy,
      ...(sim.weather.live !== undefined && { live: sim.weather.live }),
      simulated: new SimulatedWeatherProvider(
        clock,
        async () => (await control.view()).values.outdoorTemperatureC,
      ),
      bus,
      ids,
      registry: ports.registry,
      audit,
      weatherDeviceId: sim.facility.weatherDeviceId,
    });
    simulation = {
      facility: sim.facility,
      scenarios: sim.scenarios,
      policies: simPolicies,
      control,
      weather,
      createEngine: (submit) =>
        createSimulationEngine({
          clock,
          ids,
          store: ports.documents,
          facility: sim.facility,
          registry: ports.registry,
          keys: ports.keys,
          submit,
          onPulse: async ({ session }) => {
            await weather.ingest({
              ...scope,
              location: sim.facility.location,
              mode: session.weatherMode,
            });
          },
        }),
    };
  }

  const startConsumers = () => {
    startTelemetryWorker({
      bus,
      adapters: {
        HARDWARE: edgeDeviceSourceAdapter,
        SIMULATOR: simulatorSourceAdapter,
        WEATHER_API: weatherSourceAdapter,
      },
      quality: qualityFor,
      observations,
      ids,
      clock,
    });
    startSourceTelemetryWorker({
      bus,
      quality: qualityFor,
      observations,
      ids,
      clock,
      catalog,
      store: ports.documents,
    });
    startEvaluationRecorder({ bus, store: ports.documents });
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
      rule: ruleFor,
      baselineConfig: baselineFor,
    });
    startInterventions(interventionDeps, interventionService);
    startEvidenceBuilder({ bus }, evidenceService);
    startSharing({ bus }, sharingService);
    startAlerting(alertingDeps, alerting);
    startFollowUps({ bus }, followUps);
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
      policy: escalationFor,
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
    // Overdue assigned actions (the closed-loop follow-up that needs no event).
    const followUpsResult = await followUps.tick();
    return {
      escalated: escalation.escalated,
      retried,
      verification,
      evidence,
      sharing,
      followUps: followUpsResult,
    };
  };

  return {
    operations,
    interventionService,
    evidenceService,
    sharingService,
    insuranceGateway,
    verificationRunner,
    catalog,
    contacts,
    deliveries,
    followUps,
    ...(simulation !== undefined && { simulation }),
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
          knownPolicies: async (a: VerificationAttempt) =>
            (await policiesFor(a)).map((p) => ({
              policyId: p.policyId,
              policyVersion: p.policyVersion,
            })),
        },
        attempt,
      );
    },
  };
}
