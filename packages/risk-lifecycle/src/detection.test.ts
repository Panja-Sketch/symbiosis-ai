import { describe, expect, it } from "vitest";
import type { RiskDetection } from "@symbiosis/contracts";
import { caseMatchesDetection, isEpisodeActive, openCaseFromDetection } from "./index";

const detection: RiskDetection = {
  detectionId: "DET-1",
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-FAN",
  contextAssetIds: ["AST-OUT", "AST-FAN", "AST-ZONE"],
  severity: "HIGH",
  confidence: 0.9,
  detectedAt: "2026-10-01T00:00:10.000Z",
  reasonCodes: ["X"],
  supportingObservationIds: ["OBS-1"],
  baselineIds: ["BSL-1"],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: {},
};

const open = () => {
  const r = openCaseFromDetection({
    detection,
    caseId: "CASE-9",
    eventId: "RE-9",
    baselineSnapshotId: "BSNAP-1",
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("openCaseFromDetection and correlation (S3)", () => {
  it("creates an OPEN DETECTED_HAZARD case and a DETECTED event, linked to each other", () => {
    const { case: c, event } = open();
    expect(c).toMatchObject({
      caseId: "CASE-9",
      state: "OPEN",
      origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      severity: "HIGH",
      baselineSnapshotId: "BSNAP-1",
      activeRiskEventId: "RE-9",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      recurrenceCount: 0,
      createdAt: detection.detectedAt,
    });
    expect(event).toMatchObject({ eventId: "RE-9", caseId: "CASE-9", state: "DETECTED" });
  });

  it("puts the primary asset first and de-duplicates context assets", () => {
    const { case: c, event } = open();
    expect(c.assetIds).toEqual(["AST-FAN", "AST-OUT", "AST-ZONE"]);
    expect(event.assetIds).toEqual(c.assetIds);
  });

  it("matches a detection only on organization + facility + hazard + primary asset", () => {
    const { case: c } = open();
    expect(caseMatchesDetection(c, detection)).toBe(true);
    expect(caseMatchesDetection(c, { ...detection, organizationId: "ORG-2" })).toBe(false);
    expect(caseMatchesDetection(c, { ...detection, facilityId: "FAC-2" })).toBe(false);
    expect(caseMatchesDetection(c, { ...detection, hazardType: "OTHER" })).toBe(false);
    expect(caseMatchesDetection(c, { ...detection, primaryAssetId: "AST-OTHER" })).toBe(false);
  });

  it("treats closed and verified-improved cases as no longer active episodes", () => {
    const { case: c } = open();
    expect(isEpisodeActive(c)).toBe(true);
    expect(isEpisodeActive({ ...c, state: "CLOSED" })).toBe(false);
    expect(isEpisodeActive({ ...c, state: "VERIFIED_IMPROVED" })).toBe(false);
    expect(isEpisodeActive({ ...c, state: "ACTION_REQUIRED" })).toBe(true);
  });

  it("rejects an invalid detection", () => {
    const r = openCaseFromDetection({
      detection: { ...detection, primaryAssetId: "" },
      caseId: "C",
      eventId: "E",
      baselineSnapshotId: "B",
    });
    expect(r.ok).toBe(false);
  });
});
