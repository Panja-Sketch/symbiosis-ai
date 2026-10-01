import {
  Firestore,
  FirebaseIdentityResolver,
  FirestoreActionRepository,
  FirestoreActorDirectory,
  FirestoreAlertRepository,
  FirestoreAuditLog,
  FirestoreBaselineRepository,
  FirestoreCaseRepository,
  FirestoreDetectionStateRepository,
  FirestoreDeviceRegistry,
  FirestoreEventInbox,
  FirestoreEvidencePackageRepository,
  FirestoreIdentityLinks,
  FirestoreInterventionRepository,
  FirestoreObservationRepository,
  FirestoreOrganizationDirectory,
  FirestoreReplayGuard,
  FirestoreRiskEventRepository,
  FirestoreSharedEvidenceRepository,
  FirestoreSharingAgreementRepository,
  FirestoreVerificationRepository,
  GcsEvidenceObjectStore,
  PubSubBus,
  SecretManagerDeviceKeyStore,
  createAdcAccessTokenProvider,
  createBucketProbe,
  createFirebaseTokenVerifier,
  createGcsObjectClient,
  createSecretAccess,
  createTopicPublisher,
} from "@symbiosis/adapter-gcp";
import type { Logger } from "@symbiosis/adapter-gcp";
import {
  ExplanationService,
  InMemoryExplanationLog,
  selectProvider,
} from "@symbiosis/ai-explanation";
import { ProviderError } from "@symbiosis/ai-explanation";
import type {
  ExplanationGovernanceRecord,
  ExplanationLog,
  ExplanationProvider,
  ProviderRequest,
  ProviderResponse,
} from "@symbiosis/ai-explanation";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import type { IdentityResolver } from "@symbiosis/tenancy";
import { loadExplanationConfig } from "./config";
import type { Env, GcpConfig } from "./config";
import type { Ports } from "./compose";

/**
 * The production adapter set. Constructing it performs no network call; `verifyStartup` does, and
 * a runtime that cannot pass it must not serve traffic (the process exits and the Cloud Run revision
 * never becomes ready). Nothing here falls back to an in-memory implementation.
 */
export type GcpPlatform = {
  readonly ports: Ports;
  readonly bus: PubSubBus;
  readonly identity: IdentityResolver;
  readonly inbox: FirestoreEventInbox;
  readonly firestore: Firestore;
  readonly accessToken: () => Promise<string>;
  /** Throws if a critical dependency is unreachable or misconfigured. Read-only. */
  verifyStartup(): Promise<void>;
  /** Cached (10 s), read-only readiness: Firestore and the evidence bucket answer. */
  readiness(): Promise<{ readonly ready: boolean; readonly checks: Record<string, boolean> }>;
  close(): Promise<void>;
};

export function createGcpPlatform(config: GcpConfig, logger: Logger): GcpPlatform {
  const firestore = new Firestore({ projectId: config.projectId });
  const o = { db: firestore, collectionPrefix: config.collectionPrefix };

  const bus = new PubSubBus(createTopicPublisher(config.projectId, config.topic));
  const directory = new FirestoreActorDirectory(o);
  const identity = new FirebaseIdentityResolver({
    verify: createFirebaseTokenVerifier({
      projectId: config.firebaseProjectId,
      checkRevoked: config.checkRevokedTokens,
    }),
    links: new FirestoreIdentityLinks(o),
    directory,
    logger,
  });
  const objects = createBucketProbe(config.projectId, config.evidenceBucket);
  const ports: Ports = {
    bus,
    observations: new FirestoreObservationRepository(o),
    baselines: new FirestoreBaselineRepository(o),
    detectionStates: new FirestoreDetectionStateRepository(o),
    cases: new FirestoreCaseRepository(o),
    riskEvents: new FirestoreRiskEventRepository(o),
    alerts: new FirestoreAlertRepository(o),
    actions: new FirestoreActionRepository(o),
    verifications: new FirestoreVerificationRepository(o),
    interventions: new FirestoreInterventionRepository(o),
    evidencePackages: new FirestoreEvidencePackageRepository(o),
    agreements: new FirestoreSharingAgreementRepository(o),
    shares: new FirestoreSharedEvidenceRepository(o),
    evidenceStore: new GcsEvidenceObjectStore(
      createGcsObjectClient(config.projectId, config.evidenceBucket),
    ),
    audit: new FirestoreAuditLog(o),
    directory,
    organizations: new FirestoreOrganizationDirectory(o),
    registry: new FirestoreDeviceRegistry(o),
    keys: new SecretManagerDeviceKeyStore(createSecretAccess(config.projectId)),
    replayGuard: new FirestoreReplayGuard(o),
  };

  const probe = async (): Promise<Record<string, boolean>> => {
    const checks: Record<string, boolean> = {};
    try {
      await firestore.collection(`${config.collectionPrefix}system`).doc("readiness").get();
      checks.firestore = true;
    } catch {
      checks.firestore = false;
    }
    try {
      await objects.exists("evidence/.readiness-probe");
      checks.evidenceBucket = true;
    } catch {
      checks.evidenceBucket = false;
    }
    return checks;
  };

  let cached: { at: number; value: Awaited<ReturnType<GcpPlatform["readiness"]>> } | undefined;
  return {
    ports,
    bus,
    identity,
    inbox: new FirestoreEventInbox(o),
    firestore,
    accessToken: createAdcAccessTokenProvider(),
    async verifyStartup() {
      const checks = await probe();
      const failed = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (failed.length > 0) {
        throw new Error(`startup check failed: ${failed.join(", ")}`);
      }
      logger.log("INFO", "startup checks passed", { component: "runtime", checks });
    },
    async readiness() {
      if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.value;
      const checks = await probe();
      const value = { ready: Object.values(checks).every(Boolean), checks };
      cached = { at: Date.now(), value };
      return value;
    },
    async close() {
      await firestore.terminate();
    },
  };
}

/**
 * Logs why a provider call failed (error code and message only: the provider never puts a prompt,
 * response body or credential in an error) so a template fallback is explainable from the logs.
 */
export class ErrorLoggingProvider implements ExplanationProvider {
  readonly name: string;
  readonly model?: string;
  constructor(
    private readonly inner: ExplanationProvider,
    private readonly logger: Logger,
  ) {
    this.name = inner.name;
    if (inner.model !== undefined) this.model = inner.model;
  }
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      return await this.inner.generate(request);
    } catch (e) {
      this.logger.log("WARNING", "explanation provider failed", {
        component: "explanation",
        provider: this.name,
        model: this.model ?? "",
        code: e instanceof ProviderError ? e.code : "UNEXPECTED",
        detail: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}

/** Governance records go to structured logs (no prompt text, no secrets) and stay readable in-process. */
export class LoggingExplanationLog implements ExplanationLog {
  private readonly local = new InMemoryExplanationLog();
  constructor(private readonly logger: Logger) {}
  append(record: ExplanationGovernanceRecord): void {
    this.local.append(record);
    this.logger.log("INFO", "explanation governance record", {
      component: "explanation",
      caseId: record.caseId,
      correlationId: record.correlationId,
      provider: record.provider,
      model: record.model ?? "",
      validation: record.validation,
      fallbackUsed: record.fallbackUsed,
      fallbackReason: record.fallbackReason ?? "",
      latencyMs: record.latencyMs,
      cached: record.cached,
    });
  }
  list(): readonly ExplanationGovernanceRecord[] {
    return this.local.list();
  }
}

/**
 * Explanation service for the cloud: provider and model come from config/explanation (and
 * SYMBIOSIS_AI_PROVIDER / GEMINI_MODEL); the credential is the runtime identity via ADC. If Gemini
 * cannot be used, the deterministic template answers (S8 behavior is unchanged).
 */
export function createCloudExplanationService(options: {
  readonly config: GcpConfig;
  readonly env: Env;
  readonly accessToken: () => Promise<string>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}): ExplanationService {
  const env = { ...options.env, GCP_PROJECT_ID: options.config.projectId };
  const cfg = loadExplanationConfig(env);
  const chosen = selectProvider(cfg, env, undefined, options.accessToken);
  return new ExplanationService({
    primary: new ErrorLoggingProvider(chosen.primary, options.logger),
    fallback: chosen.fallback,
    clock: options.clock,
    ids: options.ids,
    log: new LoggingExplanationLog(options.logger),
    ...(chosen.note !== undefined && { primaryNote: chosen.note }),
    settings: {
      promptVersion: cfg.promptVersion,
      schemaVersion: cfg.outputSchemaVersion,
      timeoutMs: cfg.gemini.timeoutMs,
      cacheTtlMs: cfg.cache.ttlSeconds * 1000,
      fallbackCacheTtlMs: cfg.cache.fallbackTtlSeconds * 1000,
    },
  });
}
