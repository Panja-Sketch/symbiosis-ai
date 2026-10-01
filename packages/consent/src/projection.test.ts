import { describe, expect, it } from "vitest";
import { CONSENT_SCOPES, EVIDENCE_CONSENT_SCOPES } from "@symbiosis/contracts";
import type {
  ConsentScope,
  EvidencePackage,
  RiskEngineerInterventionRecommendation,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import { projectCase, projectIntervention, projectRawTelemetry } from "./projection";

const caseRecord: RiskImprovementCase = {
  caseId: "CASE-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  assetIds: ["AST-1"],
  origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
  hazardType: "COOLING_ELECTRICAL_DEGRADATION",
  title: "Cooling degradation",
  severity: "HIGH",
  state: "VERIFIED_IMPROVED",
  recurrenceCount: 1,
  sharingState: "SHARED",
  latestEvidencePackageId: "EVP-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T01:00:00.000Z",
};

const pkg = {
  packageId: "EVP-1",
  schemaVersion: "evidence-package.v1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  caseId: "CASE-1",
  verificationId: "VER-1",
  createdAt: "2026-10-01T01:00:00.000Z",
  payload: {
    recommendation: {
      origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
      source: "SYMBIOSIS",
      recommendationId: null,
      approvedActions: [{ actionLibraryId: "ACT-1", title: "Inspect", libraryVersion: "1" }],
    },
    riskEvent: {
      eventId: "EVT-1",
      state: "VERIFIED",
      detectedAt: "2026-10-01T00:00:00.000Z",
      assetIds: ["AST-1"],
      detectionReasonCodes: ["VIBRATION_Z"],
    },
    reportedActions: [
      {
        actionId: "ACTN-1",
        actionLibraryId: "ACT-1",
        title: "Inspect",
        status: "REPORTED_COMPLETE",
        assignedTo: "USR-SECRET-ASSIGNEE",
        reportedBy: "USR-SECRET-REPORTER",
        reportedAt: "2026-10-01T00:30:00.000Z",
        notes: "INTERNAL NOTE",
        attachments: ["ATT-1"],
      },
    ],
    acknowledgement: {
      auditId: "AUD-1",
      acknowledgedBy: "USR-SECRET-ACK",
      acknowledgedAt: "2026-10-01T00:10:00.000Z",
    },
    baselineWindow: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-01T00:30:00.000Z" },
    postActionWindow: { start: "2026-10-01T00:30:00.000Z", end: "2026-10-01T00:32:00.000Z" },
    requiredCriteria: [
      {
        criterionId: "VIBRATION",
        passed: true,
        role: "REQUIRED",
        outcome: "PASS",
        assetId: "AST-1",
        signal: "vibration_rms",
        metric: "z_score",
        before: { sampleCount: 3, mean: 4 },
        observed: { sampleCount: 25, mean: 0.1 },
      },
    ],
    supportingCriteria: [],
    quality: {
      dataCompleteness: 1,
      telemetryConfidence: 0.9,
      deviceHealthStatus: "HEALTHY",
      authIntegrityStatus: "VERIFIED",
    },
    verification: {
      verificationId: "VER-1",
      result: "VERIFIED",
      confidence: 0.9,
      reasonCodes: [],
      evaluatedAt: "2026-10-01T00:32:00.000Z",
      policyId: "VPOL",
      policyVersion: "1",
    },
    recurrence: {
      recurrenceCount: 0,
      recurrenceWatchEndsAt: "2026-10-01T01:32:00.000Z",
      priorVerificationIds: [],
    },
    versions: { verificationPolicy: { id: "VPOL", version: "1" } },
    auditReferences: [{}, {}],
    source: {
      dataOrigin: "SYNTHETIC_SIMULATOR",
      synthetic: true,
      sourceTypes: ["SIMULATOR"],
      sourceAdapters: [],
      label: "SYNTHETIC DATA: test",
    },
  },
  artifacts: [
    {
      id: "OBS-1",
      kind: "OBSERVATION",
      snapshot: { signal: "vibration_rms", value: 7.7 },
      sha256: "a".repeat(64),
    },
    {
      id: "DEVICE:DEV-1",
      kind: "DEVICE",
      snapshot: { health: "HEALTHY", firmwareVersion: "9.9.9" },
      sha256: "b".repeat(64),
    },
    { id: "POLICY:VPOL:1", kind: "POLICY", snapshot: { thresholds: 1 }, sha256: "c".repeat(64) },
  ],
  manifest: {
    hashAlgorithm: "SHA-256",
    canonicalization: "symbiosis-canonical-json.v1",
    payloadSha256: "d".repeat(64),
    artifacts: [
      { id: "OBS-1", kind: "OBSERVATION", sha256: "a".repeat(64) },
      { id: "DEVICE:DEV-1", kind: "DEVICE", sha256: "b".repeat(64) },
      { id: "POLICY:VPOL:1", kind: "POLICY", sha256: "c".repeat(64) },
    ],
  },
  manifestSha256: "e".repeat(64),
} as unknown as EvidencePackage;

const project = (scopes: readonly ConsentScope[], withPackage = true) =>
  projectCase({
    caseRecord,
    agreementIds: ["AGR-1"],
    grantedScopes: scopes,
    ...(withPackage && { pkg }),
  });

const SECTIONS = [
  "recommendation",
  "eventSummary",
  "actionSummary",
  "verification",
  "confidence",
  "beforeAfter",
  "recurrence",
  "evidencePackage",
] as const;
const present = (v: object) =>
  SECTIONS.filter((k) => (v as Record<string, unknown>)[k] !== undefined);

describe("insurer projection", () => {
  it("with no package-bearing scope, even a package is not mentioned", () => {
    const v = project(["RECOMMENDATION"]);
    expect(present(v)).toEqual(["recommendation"]);
    expect(v.evidenceAvailable).toBeUndefined();
    expect(v.source).toBeUndefined();
    expect(v.recommendation?.approvedActions).toEqual([
      { actionLibraryId: "ACT-1", title: "Inspect" },
    ]);
  });

  it("each scope adds only its section", () => {
    const pairs: [ConsentScope, (typeof SECTIONS)[number]][] = [
      ["RECOMMENDATION", "recommendation"],
      ["EVENT_SUMMARY", "eventSummary"],
      ["ACTION_SUMMARY", "actionSummary"],
      ["BEFORE_AFTER_METRICS", "beforeAfter"],
      ["VERIFICATION_RESULT", "verification"],
      ["VERIFICATION_CONFIDENCE", "confidence"],
      ["RECURRENCE_STATUS", "recurrence"],
      ["EVIDENCE_ARTIFACTS", "evidencePackage"],
    ];
    for (const [scope, section] of pairs)
      expect(present(project([scope])), scope).toEqual([section]);
  });

  it("intervention and raw scopes add no case section", () => {
    expect(present(project(["INTERVENTION_RECOMMENDATION"]))).toEqual([]);
    expect(present(project(["RAW_TELEMETRY"]))).toEqual([]);
  });

  it("never reveals notes, actor ids, attachments, device facts, raw values or policy content", () => {
    const text = JSON.stringify(project([...EVIDENCE_CONSENT_SCOPES]));
    for (const secret of [
      "INTERNAL NOTE",
      "USR-SECRET",
      "ATT-1",
      "firmware",
      "9.9.9",
      "7.7",
      "thresholds",
      "OBS-1",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // artifact descriptors name kind, id and hash only; raw observations are counted, not listed
    const v = project(["EVIDENCE_ARTIFACTS"]);
    expect(v.evidencePackage?.artifacts.map((a) => a.kind)).toEqual(["DEVICE", "POLICY"]);
    expect(v.evidencePackage?.observationArtifactCount).toBe(1);
  });

  it("labels synthetic data whenever package content is shown", () => {
    const v = project(["VERIFICATION_RESULT"]);
    expect(v.source).toEqual({
      dataOrigin: "SYNTHETIC_SIMULATOR",
      synthetic: true,
      label: "SYNTHETIC DATA: test",
    });
  });

  it("reports the recorded result faithfully and the live recurrence next to the package value", () => {
    const v = project(["VERIFICATION_RESULT", "RECURRENCE_STATUS"]);
    expect(v.verification).toMatchObject({ result: "VERIFIED", resultLabel: "VERIFIED IMPROVED" });
    expect(v.recurrence).toEqual({
      recurrenceCountAtPackage: 0,
      currentRecurrenceCount: 1,
      reopenedSincePackage: true,
      recurrenceWatchEndsAt: "2026-10-01T01:32:00.000Z",
    });
    const notImproving = {
      ...pkg,
      payload: {
        ...pkg.payload,
        verification: { ...pkg.payload.verification, result: "NOT_IMPROVING" as const },
      },
    } as EvidencePackage;
    const w = projectCase({
      caseRecord,
      agreementIds: [],
      grantedScopes: ["VERIFICATION_RESULT"],
      pkg: notImproving,
    });
    expect(w.verification?.resultLabel).toBe("NOT IMPROVING");
    expect(w.verification?.interpretation).not.toMatch(/met every required criterion/);
  });

  it("without a package, package sections are absent and evidenceAvailable is false", () => {
    const v = project([...EVIDENCE_CONSENT_SCOPES], false);
    expect(present(v)).toEqual(["recommendation"]);
    expect(v.evidenceAvailable).toBe(false);
  });

  it("every scope in the vocabulary is handled (no scope silently releases everything)", () => {
    for (const scope of CONSENT_SCOPES)
      expect(present(project([scope])).length, scope).toBeLessThanOrEqual(1);
  });

  it("raw telemetry is the only projection that lists observation values", () => {
    const raw = projectRawTelemetry(pkg);
    expect(raw.scope).toBe("RAW_TELEMETRY");
    expect(raw.observations).toEqual([{ signal: "vibration_rms", value: 7.7 }]);
  });

  it("interventions expose level, policy and reasons but no evidence ids or actors", () => {
    const r: RiskEngineerInterventionRecommendation = {
      interventionId: "INT-1",
      organizationId: "ORG-A",
      facilityId: "FAC-1",
      caseId: "CASE-1",
      level: "REMOTE_REVIEW",
      policyId: "IPOL",
      policyVersion: "1",
      reasonCodes: ["R1"],
      supportingEvidenceIds: ["OBS-SECRET"],
      dataSufficiency: 0.8,
      generatedAt: "2026-10-01T00:00:00.000Z",
      status: "ACKNOWLEDGED",
      acknowledgedBy: "USR-SECRET",
    };
    const v = projectIntervention(r);
    expect(v).toMatchObject({ level: "REMOTE_REVIEW", label: "Remote Review", siteId: "FAC-1" });
    expect(JSON.stringify(v)).not.toMatch(/OBS-SECRET|USR-SECRET/);
  });
});
