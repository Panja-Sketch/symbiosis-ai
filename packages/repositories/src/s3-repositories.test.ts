import { describe, expect, it } from "vitest";
import type { Baseline, BaselineKey, RiskEvent, RiskImprovementCase } from "@symbiosis/contracts";
import {
  InMemoryBaselineRepository,
  InMemoryCaseRepository,
  InMemoryDetectionStateRepository,
  InMemoryRiskEventRepository,
} from "./index";

const key: BaselineKey = {
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetId: "AST-1",
  signal: "vibration_rms",
  operatingMode: "HIGH_LOAD",
};
const baseline = (
  version: number,
  status: Baseline["status"],
  over: Partial<Baseline> = {},
): Baseline => ({
  baselineId: `BSL-v${version}`,
  key,
  version,
  status,
  configVersion: "c1",
  observationCount: 5,
  mean: 1,
  m2: 0,
  min: 1,
  max: 1,
  ...over,
});
const T = "2026-10-01T00:00:00.000Z";

describe("InMemoryBaselineRepository", () => {
  it("returns the newest non-superseded baseline as active and keeps history", async () => {
    const repo = new InMemoryBaselineRepository();
    await repo.save(baseline(1, "SUPERSEDED"));
    await repo.save(baseline(2, "LEARNING"));
    expect((await repo.getActive(key))?.baselineId).toBe("BSL-v2");
    expect((await repo.history(key)).map((b) => b.version)).toEqual([1, 2]);
    expect((await repo.listActive("ORG-1", "FAC-1")).map((b) => b.baselineId)).toEqual(["BSL-v2"]);
  });

  it("keeps historical statistics when a baseline is superseded", async () => {
    const repo = new InMemoryBaselineRepository();
    await repo.save(baseline(1, "READY", { mean: 0.18 }));
    await repo.save(baseline(1, "SUPERSEDED", { mean: 0.18, supersededBy: "BSL-v2" }));
    await repo.save(baseline(2, "LEARNING", { observationCount: 0, mean: 0 }));
    const history = await repo.history(key);
    expect(history[0]).toMatchObject({ status: "SUPERSEDED", mean: 0.18, supersededBy: "BSL-v2" });
    expect(history[1]).toMatchObject({ status: "LEARNING" });
  });

  it("scopes by organization and facility", async () => {
    const repo = new InMemoryBaselineRepository();
    await repo.save(baseline(1, "READY"));
    expect(await repo.listActive("ORG-2", "FAC-1")).toEqual([]);
    expect(await repo.listActive("ORG-1", "FAC-2")).toEqual([]);
    expect(await repo.getActive({ ...key, assetId: "AST-2" })).toBeUndefined();
  });

  it("stores snapshots and audit records per organization", async () => {
    const repo = new InMemoryBaselineRepository();
    await repo.saveSnapshot({
      snapshotId: "S1",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      baselineIds: ["a"],
      createdAt: T,
    });
    expect((await repo.getSnapshot("ORG-1", "S1"))?.baselineIds).toEqual(["a"]);
    expect(await repo.getSnapshot("ORG-2", "S1")).toBeUndefined();
    await repo.appendAudit({
      action: "REBASELINE",
      key,
      supersededBaselineId: "a",
      newBaselineId: "b",
      actorId: "U",
      reason: "r",
      at: T,
    });
    expect(await repo.listAudit("ORG-1")).toHaveLength(1);
    expect(await repo.listAudit("ORG-2")).toEqual([]);
  });
});

const mkCase = (over: Partial<RiskImprovementCase> = {}): RiskImprovementCase => ({
  caseId: "CASE-1",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetIds: ["AST-FAN", "AST-ZONE"],
  origin: { type: "DETECTED_HAZARD", detectionId: "D" },
  hazardType: "H",
  title: "t",
  severity: "HIGH",
  state: "OPEN",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe("InMemoryCaseRepository.findActive (case correlation)", () => {
  it("finds an unresolved case by org + facility + hazard + primary asset", async () => {
    const repo = new InMemoryCaseRepository();
    await repo.save(mkCase());
    expect((await repo.findActive("ORG-1", "FAC-1", "H", "AST-FAN"))?.caseId).toBe("CASE-1");
  });

  it.each([
    ["organization", ["ORG-2", "FAC-1", "H", "AST-FAN"]],
    ["facility", ["ORG-1", "FAC-2", "H", "AST-FAN"]],
    ["hazard", ["ORG-1", "FAC-1", "OTHER", "AST-FAN"]],
    ["primary asset", ["ORG-1", "FAC-1", "H", "AST-ZONE"]],
  ] as const)("does not match a different %s", async (_n, [o, f, h, a]) => {
    const repo = new InMemoryCaseRepository();
    await repo.save(mkCase());
    expect(await repo.findActive(o, f, h, a)).toBeUndefined();
  });

  it("ignores closed and verified-improved cases", async () => {
    const repo = new InMemoryCaseRepository();
    await repo.save(mkCase({ state: "CLOSED" }));
    await repo.save(
      mkCase({ caseId: "CASE-2", state: "VERIFIED_IMPROVED", latestVerificationId: "V" }),
    );
    expect(await repo.findActive("ORG-1", "FAC-1", "H", "AST-FAN")).toBeUndefined();
  });

  it("get and list are organization-scoped", async () => {
    const repo = new InMemoryCaseRepository();
    await repo.save(mkCase());
    expect(await repo.get("ORG-2", "CASE-1")).toBeUndefined();
    expect(await repo.list("ORG-2")).toEqual([]);
  });
});

describe("other S3 repositories", () => {
  it("risk events are stored and listed by case within an organization", async () => {
    const repo = new InMemoryRiskEventRepository();
    const e: RiskEvent = {
      eventId: "RE-1",
      caseId: "CASE-1",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      assetIds: ["A"],
      state: "DETECTED",
      detectedAt: T,
      updatedAt: T,
    };
    await repo.save(e);
    expect(await repo.listByCase("ORG-1", "CASE-1")).toEqual([e]);
    expect(await repo.listByCase("ORG-2", "CASE-1")).toEqual([]);
    expect(await repo.get("ORG-1", "RE-1")).toEqual(e);
  });

  it("detection state round-trips by key", async () => {
    const repo = new InMemoryDetectionStateRepository();
    const state = {
      stateKey: "k",
      organizationId: "O",
      facilityId: "F",
      ruleId: "R",
      facts: {},
      zoneSamples: {},
      persistence: {},
    };
    expect(await repo.get("k")).toBeUndefined();
    await repo.save(state);
    expect(await repo.get("k")).toEqual(state);
  });
});
