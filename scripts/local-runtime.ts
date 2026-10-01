import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createApiHandler,
  createAppHandler,
  createEdgeHandler,
  createEdgeServer,
  listen,
} from "@symbiosis/api";
import type { RunningServer } from "@symbiosis/api";
import type { EdgeLogEntry } from "@symbiosis/api";
import { createOperations, parseActionLibrary } from "@symbiosis/action-orchestration";
import type { ActionLibrary, Operations } from "@symbiosis/action-orchestration";
import { esp32SourceAdapter } from "@symbiosis/adapter-esp32";
import { simulatorSourceAdapter } from "@symbiosis/adapter-simulator";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { SystemClock } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { parseBaselineConfig } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import { createSyntheticDevRegistry } from "@symbiosis/device-registry";
import type { DeviceRegistry, DeviceKeyStore } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import { parseEscalationPolicy, runEscalationTick } from "@symbiosis/escalation";
import type { EscalationPolicy } from "@symbiosis/escalation";
import { InMemoryBus, RandomIdGenerator } from "@symbiosis/event-bus";
import type { IdGenerator } from "@symbiosis/event-bus";
import { ConsoleEmail, createAlerting, startAlerting } from "@symbiosis/notifications";
import type { NotificationSender } from "@symbiosis/notifications";
import { createSyntheticActorDirectory } from "@symbiosis/tenancy";
import {
  InMemoryActionRepository,
  InMemoryAlertRepository,
  InMemoryBaselineRepository,
  InMemoryCaseRepository,
  InMemoryDetectionStateRepository,
  InMemoryObservationRepository,
  InMemoryRiskEventRepository,
} from "@symbiosis/repositories";
import { parseRuleConfig } from "@symbiosis/risk-detection";
import type { RuleConfig } from "@symbiosis/risk-detection";
import { startRiskPipeline, startTelemetryWorker } from "@symbiosis/worker";

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
  /** Replaces ConsoleEmail (tests inject a scripted sender). */
  readonly notificationSender?: NotificationSender;
  /** Where ConsoleEmail writes; defaults to console.log. */
  readonly consoleSink?: (line: string) => void;
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
  readonly audit: InMemoryAuditLog;
  readonly operations: Operations;
  readonly directory: ReturnType<typeof createSyntheticActorDirectory>;
  /** One escalation + alert-retry pass (what a scheduler tick calls). */
  tick(): Promise<{
    escalated: readonly { riskEventId: string; caseId: string }[];
    retried: number;
  }>;
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly clock: Clock;
  close(): Promise<void>;
};

const repoRoot = join(import.meta.dirname, "..");

export function loadDataQualityConfig() {
  const path = join(repoRoot, "config", "rules", "data-quality.v1.json");
  return parseDataQualityConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function loadBaselineConfig(): BaselineConfig {
  const path = join(repoRoot, "config", "rules", "baselines.v1.json");
  return parseBaselineConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function loadRuleConfig(): RuleConfig {
  const path = join(repoRoot, "config", "rules", "cooling-electrical.v1.json");
  return parseRuleConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function loadEscalationPolicy(): EscalationPolicy {
  const path = join(repoRoot, "config", "escalation", "escalation.v1.json");
  return parseEscalationPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function loadActionLibrary(): ActionLibrary {
  const path = join(repoRoot, "config", "action-library", "cooling-actions.v1.json");
  return parseActionLibrary(JSON.parse(readFileSync(path, "utf8")));
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
  const audit = new InMemoryAuditLog();
  const directory = createSyntheticActorDirectory();
  const policy = options.escalationPolicy ?? loadEscalationPolicy();
  const library = options.actionLibrary ?? loadActionLibrary();
  const { registry, keys } = createSyntheticDevRegistry();

  startTelemetryWorker({
    bus,
    adapters: { HARDWARE: esp32SourceAdapter, SIMULATOR: simulatorSourceAdapter },
    quality: loadDataQualityConfig(),
    observations,
    ids,
    clock,
  });

  startRiskPipeline({
    bus,
    ids,
    clock,
    baselines,
    detectionStates,
    cases,
    riskEvents,
    audit,
    rule: options.ruleConfig ?? loadRuleConfig(),
    baselineConfig: options.baselineConfig ?? loadBaselineConfig(),
  });

  const alertingDeps = {
    bus,
    ids,
    clock,
    alerts,
    cases,
    riskEvents,
    audit,
    directory,
    sender: options.notificationSender ?? new ConsoleEmail(clock, options.consoleSink),
    policy,
  };
  const alerting = createAlerting(alertingDeps);
  startAlerting(alertingDeps, alerting);
  const operations = createOperations({
    cases,
    riskEvents,
    actions,
    alerts,
    audit,
    bus,
    ids,
    clock,
    library,
    directory,
  });
  // One scheduler-style pass. Retries run first so an alert that has just become exhausted is
  // escalated in the same tick instead of waiting for the next one.
  const tick = async () => {
    const retried = await alerting.retryDueAlerts();
    const escalation = await runEscalationTick({
      alerts,
      cases,
      riskEvents,
      audit,
      bus,
      ids,
      clock,
      policy,
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
    return { escalated: escalation.escalated, retried };
  };

  const edgeHandler = createEdgeHandler({
    registry,
    keys,
    replayGuard: new InMemoryReplayGuard(),
    bus,
    clock,
    ids,
    ...(options.log !== undefined && { log: options.log }),
  });
  const handler = createApiHandler({
    edge: edgeHandler,
    app: createAppHandler({ operations, directory, runTick: tick }),
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
