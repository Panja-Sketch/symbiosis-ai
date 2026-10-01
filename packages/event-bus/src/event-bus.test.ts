import { describe, expect, it } from "vitest";
import type { PlatformEvent } from "@symbiosis/contracts";
import { InMemoryBus, SequentialIdGenerator, createEnvelope } from "./index";

const ids = new SequentialIdGenerator();
const received = (n: number): PlatformEvent =>
  createEnvelope(ids, {
    type: "telemetry.received.v1",
    correlationId: `CORR-${n}`,
    causationId: null,
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    occurredAt: "2026-09-29T20:00:00.000Z",
    producer: "api",
    payload: {
      deviceId: "D",
      keyId: "K",
      seq: n,
      bodySha256: "x",
      byteLength: 1,
      receivedAt: "2026-09-29T20:00:00.000Z",
    },
  });

describe("InMemoryBus", () => {
  it("delivers to subscribers of the matching type only, in order", async () => {
    const bus = new InMemoryBus();
    const seen: string[] = [];
    bus.subscribe("telemetry.received.v1", (e) => void seen.push(e.correlation_id));
    bus.subscribe("telemetry.normalized.v1", () => void seen.push("WRONG"));
    await bus.publish(received(1));
    await bus.publish(received(2));
    expect(seen).toEqual(["CORR-1", "CORR-2"]);
  });

  it("records history in publish order", async () => {
    const bus = new InMemoryBus();
    const a = received(1);
    const b = received(2);
    await bus.publish(a);
    await bus.publish(b);
    expect(bus.history()).toEqual([a, b]);
  });

  it("queues events published from handlers behind the current one (deterministic order)", async () => {
    const bus = new InMemoryBus();
    const order: string[] = [];
    bus.subscribe("telemetry.received.v1", async (e) => {
      order.push(`handle-${e.correlation_id}`);
      if (e.correlation_id === "CORR-1") await bus.publish(received(2));
      order.push(`done-${e.correlation_id}`);
    });
    await bus.publish(received(1));
    expect(order).toEqual(["handle-CORR-1", "done-CORR-1", "handle-CORR-2", "done-CORR-2"]);
    expect(bus.history().map((e) => e.correlation_id)).toEqual(["CORR-1", "CORR-2"]);
  });

  it("isolates handler failures as dead letters and keeps delivering", async () => {
    const bus = new InMemoryBus();
    const seen: string[] = [];
    bus.subscribe("telemetry.received.v1", () => {
      throw new Error("boom");
    });
    bus.subscribe("telemetry.received.v1", (e) => void seen.push(e.correlation_id));
    await expect(bus.publish(received(1))).resolves.toBeUndefined();
    expect(seen).toEqual(["CORR-1"]);
    expect(bus.deadLetters()).toHaveLength(1);
  });

  it("supports unsubscribe", async () => {
    const bus = new InMemoryBus();
    const seen: string[] = [];
    const off = bus.subscribe("telemetry.received.v1", (e) => void seen.push(e.correlation_id));
    await bus.publish(received(1));
    off();
    await bus.publish(received(2));
    expect(seen).toEqual(["CORR-1"]);
  });
});

describe("createEnvelope", () => {
  it("fills every spec envelope field", () => {
    const e = received(7);
    expect(Object.keys(e).sort()).toEqual(
      [
        "causation_id",
        "correlation_id",
        "event_id",
        "event_type",
        "facility_id",
        "occurred_at",
        "organization_id",
        "payload",
        "producer",
        "schema_version",
      ].sort(),
    );
    expect(e.schema_version).toBe("1.0");
    expect(e.event_id.startsWith("EVT-")).toBe(true);
  });

  it("generates deterministic sequential IDs for tests", () => {
    const g = new SequentialIdGenerator();
    expect([g.next("EVT"), g.next("EVT"), g.next("CORR")]).toEqual([
      "EVT-000001",
      "EVT-000002",
      "CORR-000003",
    ]);
  });
});
