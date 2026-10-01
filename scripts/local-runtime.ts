import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEdgeHandler, createEdgeServer, listen } from "@symbiosis/api";
import type { RunningServer } from "@symbiosis/api";
import type { EdgeLogEntry } from "@symbiosis/api";
import { esp32SourceAdapter } from "@symbiosis/adapter-esp32";
import { simulatorSourceAdapter } from "@symbiosis/adapter-simulator";
import { SystemClock } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import { createSyntheticDevRegistry } from "@symbiosis/device-registry";
import type { DeviceRegistry, DeviceKeyStore } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import { InMemoryBus, RandomIdGenerator } from "@symbiosis/event-bus";
import type { IdGenerator } from "@symbiosis/event-bus";
import { InMemoryObservationRepository } from "@symbiosis/repositories";
import { startTelemetryWorker } from "@symbiosis/worker";

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
};

export type LocalRuntime = {
  readonly server: RunningServer;
  readonly bus: InMemoryBus;
  readonly observations: InMemoryObservationRepository;
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

export async function createLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new RandomIdGenerator();
  const bus = new InMemoryBus();
  const observations = new InMemoryObservationRepository();
  const { registry, keys } = createSyntheticDevRegistry();

  startTelemetryWorker({
    bus,
    adapters: { HARDWARE: esp32SourceAdapter, SIMULATOR: simulatorSourceAdapter },
    quality: loadDataQualityConfig(),
    observations,
    ids,
    clock,
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
  return { server, bus, observations, registry, keys, clock, close: () => server.close() };
}
