import { describe, expect, it } from "vitest";
import type { CanonicalObservation } from "@symbiosis/contracts";
import { InMemoryObservationRepository } from "./index";

const obs = (over: Partial<CanonicalObservation> = {}): CanonicalObservation => ({
  observationId: "OBS-1",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetId: "AST-1",
  deviceId: "DEV-1",
  signal: "temperature",
  value: 4.2,
  unit: "degC",
  observedAt: "2026-09-29T20:00:00.000Z",
  receivedAt: "2026-09-29T20:00:05.000Z",
  sourceType: "SIMULATOR",
  sourceAdapter: "sim",
  quality: {
    confidence: 1,
    stale: false,
    outOfRange: false,
    deviceHealthy: true,
    authVerified: true,
  },
  ...over,
});

describe("InMemoryObservationRepository dedupe (device + signal + observedAt)", () => {
  it("stores the first observation and drops an identical-key duplicate", async () => {
    const repo = new InMemoryObservationRepository();
    expect(await repo.insertIfAbsent(obs())).toBe(true);
    expect(await repo.insertIfAbsent(obs({ value: 99 }))).toBe(false);
    const stored = await repo.list("ORG-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe(4.2);
  });

  it("keeps a different signal at the same timestamp", async () => {
    const repo = new InMemoryObservationRepository();
    await repo.insertIfAbsent(obs());
    expect(await repo.insertIfAbsent(obs({ signal: "current", value: 0.3 }))).toBe(true);
    expect(await repo.list("ORG-1")).toHaveLength(2);
  });

  it("keeps the same signal at a different timestamp", async () => {
    const repo = new InMemoryObservationRepository();
    await repo.insertIfAbsent(obs());
    expect(await repo.insertIfAbsent(obs({ observedAt: "2026-09-29T20:00:10.000Z" }))).toBe(true);
  });

  it("keeps the same signal and timestamp from a different device", async () => {
    const repo = new InMemoryObservationRepository();
    await repo.insertIfAbsent(obs());
    expect(await repo.insertIfAbsent(obs({ deviceId: "DEV-2" }))).toBe(true);
  });

  it("scopes list() to the organization", async () => {
    const repo = new InMemoryObservationRepository();
    await repo.insertIfAbsent(obs());
    await repo.insertIfAbsent(obs({ organizationId: "ORG-2", deviceId: "DEV-9" }));
    expect(await repo.list("ORG-1")).toHaveLength(1);
    expect(await repo.list("ORG-3")).toEqual([]);
  });
});
