import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  EdgeTelemetryPayload,
  PlatformEvent,
  TelemetryAuthenticatedEvent,
} from "@symbiosis/contracts";
import { ManualClock } from "@symbiosis/clock";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import { InMemoryBus, SequentialIdGenerator, createEnvelope } from "@symbiosis/event-bus";
import { createEdgeV1Adapter } from "@symbiosis/normalization";
import { InMemoryObservationRepository } from "@symbiosis/repositories";
import { startTelemetryWorker } from "./index";

const quality = parseDataQualityConfig(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "config", "rules", "data-quality.v1.json"),
      "utf8",
    ),
  ),
);

let bus: InMemoryBus;
let repo: InMemoryObservationRepository;
let ids: SequentialIdGenerator;

beforeEach(() => {
  bus = new InMemoryBus();
  repo = new InMemoryObservationRepository();
  ids = new SequentialIdGenerator();
  startTelemetryWorker({
    bus,
    adapters: { SIMULATOR: createEdgeV1Adapter({ adapterName: "sim", sourceType: "SIMULATOR" }) },
    quality,
    observations: repo,
    ids,
    clock: new ManualClock(Date.parse("2026-09-29T20:00:06Z")),
  });
});

function authenticated(
  readings: EdgeTelemetryPayload["batch"][number]["readings"],
  over: {
    observedAt?: string;
    deviceHealth?: "HEALTHY" | "UNKNOWN" | "FAULT";
    source?: "SIMULATOR" | "HARDWARE";
  } = {},
): TelemetryAuthenticatedEvent {
  return createEnvelope(ids, {
    type: "telemetry.authenticated.v1",
    correlationId: "CORR-T",
    causationId: "EVT-RECEIVED",
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    occurredAt: "2026-09-29T20:00:05.000Z",
    producer: "api",
    payload: {
      deviceId: "DEV-1",
      keyId: "K",
      seq: 1,
      receivedAt: "2026-09-29T20:00:05.000Z",
      assetId: "AST-1",
      expectedSignals: ["temperature", "current", "equipment_running"],
      deviceHealth: over.deviceHealth ?? "HEALTHY",
      telemetry: {
        device_id: "DEV-1",
        firmware_version: "1",
        source: over.source ?? "SIMULATOR",
        batch: [{ observed_at: over.observedAt ?? "2026-09-29T20:00:00Z", readings }],
      },
    },
  });
}

const types = (events: readonly PlatformEvent[]) => events.map((e) => e.event_type);

describe("telemetry worker", () => {
  it("emits normalized then quality_assessed with a correlation/causation chain", async () => {
    const trigger = authenticated({
      temperature_c: 4.2,
      current_ma: 312,
      chiller_b_running: false,
    });
    await bus.publish(trigger);
    const history = bus.history();
    expect(types(history)).toEqual([
      "telemetry.authenticated.v1",
      "telemetry.normalized.v1",
      "telemetry.quality_assessed.v1",
    ]);
    const [, normalized, assessed] = history;
    expect(normalized?.causation_id).toBe(trigger.event_id);
    expect(assessed?.causation_id).toBe(normalized?.event_id);
    for (const e of history) {
      expect(e.correlation_id).toBe("CORR-T");
      expect(e.organization_id).toBe("ORG-1");
      expect(e.facility_id).toBe("FAC-1");
    }
    expect(normalized?.producer).toBe("worker");
  });

  it("never emits downstream risk events (S3+)", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2 }));
    for (const e of bus.history()) expect(e.event_type.startsWith("risk.")).toBe(false);
    expect(bus.history().some((e) => /case|alert|verification/.test(e.event_type))).toBe(false);
  });

  it("produces canonical observations with propagated quality, and stores them", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2, current_ma: 312 }));
    const assessed = bus.history().at(-1);
    if (assessed?.event_type !== "telemetry.quality_assessed.v1") throw new Error("wrong event");
    expect(assessed.payload.observations.map((o) => o.signal).sort()).toEqual([
      "current",
      "temperature",
    ]);
    for (const o of assessed.payload.observations) {
      expect(o.quality).toEqual({
        confidence: 1,
        stale: false,
        outOfRange: false,
        deviceHealthy: true,
        authVerified: true,
      });
    }
    expect(await repo.list("ORG-1")).toHaveLength(2);
  });

  it("does not turn unknown device health into healthy data", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2 }, { deviceHealth: "UNKNOWN" }));
    const assessed = bus.history().at(-1);
    if (assessed?.event_type !== "telemetry.quality_assessed.v1") throw new Error("wrong event");
    expect(assessed.payload.observations[0]?.quality).toMatchObject({
      deviceHealthy: false,
      confidence: 0.5,
    });
    expect(assessed.payload.assessments[0]?.reasons).toEqual(["DEVICE_HEALTH_UNKNOWN"]);
  });

  it("flags stale and out-of-range readings", async () => {
    await bus.publish(
      authenticated({ temperature_c: 900 }, { observedAt: "2026-09-29T19:50:00Z" }),
    );
    const assessed = bus.history().at(-1);
    if (assessed?.event_type !== "telemetry.quality_assessed.v1") throw new Error("wrong event");
    expect(assessed.payload.observations[0]?.quality).toMatchObject({
      stale: true,
      outOfRange: true,
      confidence: 0,
    });
  });

  it("dedupes device + signal + observedAt: a redelivered event emits nothing twice", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2 }));
    await bus.publish(authenticated({ temperature_c: 4.2 }));
    expect(await repo.list("ORG-1")).toHaveLength(1);
    const events = bus.history().filter((e) => e.event_type === "telemetry.normalized.v1");
    const second = events[1];
    if (second?.event_type !== "telemetry.normalized.v1") throw new Error("wrong event");
    expect(second.payload.observations).toEqual([]);
    expect(second.payload.duplicatesDropped).toBe(1);
    const assessed = bus.history().filter((e) => e.event_type === "telemetry.quality_assessed.v1");
    const last = assessed[1];
    if (last?.event_type !== "telemetry.quality_assessed.v1") throw new Error("wrong event");
    expect(last.payload.observations).toEqual([]);
  });

  it("treats a different signal at the same time, or the same signal at a new time, as new", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2 }));
    await bus.publish(authenticated({ current_ma: 300 }));
    await bus.publish(
      authenticated({ temperature_c: 4.3 }, { observedAt: "2026-09-29T20:00:01Z" }),
    );
    expect(await repo.list("ORG-1")).toHaveLength(3);
  });

  it("reports rejected readings instead of dropping them silently", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2, mystery: 1 }));
    const normalized = bus.history().find((e) => e.event_type === "telemetry.normalized.v1");
    if (normalized?.event_type !== "telemetry.normalized.v1") throw new Error("wrong event");
    expect(normalized.payload.rejectedReadings).toEqual([
      { observedAt: "2026-09-29T20:00:00.000Z", field: "mystery", reason: "UNMAPPED_FIELD" },
    ]);
  });

  it("dead-letters an event whose source has no adapter instead of inventing data", async () => {
    await bus.publish(authenticated({ temperature_c: 4.2 }, { source: "HARDWARE" }));
    expect(bus.deadLetters()).toHaveLength(1);
    expect(types(bus.history())).toEqual(["telemetry.authenticated.v1"]);
  });
});
