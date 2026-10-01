import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEdgeHandler, createEdgeServer, listen } from "@symbiosis/api";
import type { RunningServer } from "@symbiosis/api";
import type { EdgeLogEntry } from "@symbiosis/api";
import { esp32SourceAdapter } from "@symbiosis/adapter-esp32";
import { simulatorSourceAdapter } from "@symbiosis/adapter-simulator";
import { SystemClock } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { parseBaselineConfig } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import { createSyntheticDevRegistry } from "@symbiosis/device-registry";
import type { DeviceRegistry, DeviceKeyStore } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import { InMemoryBus, RandomIdGenerator } from "@symbiosis/event-bus";
import type { IdGenerator } from "@symbiosis/event-bus";
import {
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
};

export type LocalRuntime = {
  readonly server: RunningServer;
  readonly bus: InMemoryBus;
  readonly observations: InMemoryObservationRepository;
  readonly baselines: InMemoryBaselineRepository;
  readonly detectionStates: InMemoryDetectionStateRepository;
  readonly cases: InMemoryCaseRepository;
  readonly riskEvents: InMemoryRiskEventRepository;
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

export async function createLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new RandomIdGenerator();
  const bus = new InMemoryBus();
  const observations = new InMemoryObservationRepository();
  const baselines = new InMemoryBaselineRepository();
  const detectionStates = new InMemoryDetectionStateRepository();
  const cases = new InMemoryCaseRepository();
  const riskEvents = new InMemoryRiskEventRepository();
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
    rule: options.ruleConfig ?? loadRuleConfig(),
    baselineConfig: options.baselineConfig ?? loadBaselineConfig(),
  });

  const handler = createEdgeHandler({
    registry,
    keys,
    replayGuard: new InMemoryReplayGuard(),
    bus,
    clock,
    ids,
    ...(options.log !== undefined && { log: options.log }),
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
    registry,
    keys,
    clock,
    close: () => server.close(),
  };
}
