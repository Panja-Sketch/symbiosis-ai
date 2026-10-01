import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  InterventionFacts,
  RiskImprovementCase,
  VerificationAttempt,
} from "@symbiosis/contracts";
import { INTERVENTION_LEVELS } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import {
  InMemoryCaseRepository,
  InMemoryInterventionRepository,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import { createSyntheticActorDirectory } from "@symbiosis/tenancy";
import { sampleAssessment } from "@symbiosis/verification/testing";
import {
  FACT_NAMES,
  buildInterventionFacts,
  createInterventionService,
  evaluateInterventionPolicy,
  parseInterventionPolicy,
} from "./index";

const raw = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "config",
      "intervention-policy",
      "risk-engineer-prioritization.v1.json",
    ),
    "utf8",
  ),
);
const policy = parseInterventionPolicy(raw);

const calm: InterventionFacts = {
  caseSeverity: "MODERATE",
  caseState: "OPEN",
  caseUnresolved: true,
  latestVerificationResult: "NONE",
  notImprovingCount: 0,
  partiallyVerifiedCount: 0,
  inconclusiveCount: 0,
  consecutiveUnsuccessfulVerifications: 0,
  recurrenceCount: 0,
  escalated: false,
  dataSufficiency: 1,
  telemetryConfidence: 1,
  integrityIssue: false,
  corroboratingSignals: 3,
  insufficientRemoteEvidence: false,
};
const facts = (over: Partial<InterventionFacts>): InterventionFacts => ({ ...calm, ...over });

describe("policy", () => {
  it("only allows the four levels, and uses only trusted fact names", () => {
    for (const r of policy.rules) expect(INTERVENTION_LEVELS).toContain(r.level);
    expect(INTERVENTION_LEVELS).toEqual([
      "REMOTE_MONITORING",
      "REMOTE_REVIEW",
      "RISK_ENGINEER_REVIEW",
      "SITE_VISIT_RECOMMENDED",
    ]);
    // no personal / demographic / generated inputs
    expect(FACT_NAMES.join(" ")).not.toMatch(/name|age|gender|race|email|ai|gemini|llm|text/i);
  });

  it("fails closed on malformed or unsupported policies", () => {
    expect(() => parseInterventionPolicy(null)).toThrow();
    expect(() => parseInterventionPolicy({ ...raw, schema: "intervention-policy.v9" })).toThrow(
      /unsupported/,
    );
    expect(() =>
      parseInterventionPolicy({
        ...raw,
        rules: [{ ruleId: "X", level: "SCHEDULE_NOW", reasonCode: "X", when: [] }],
      }),
    ).toThrow();
    expect(() =>
      parseInterventionPolicy({
        ...raw,
        rules: [
          {
            ruleId: "X",
            level: "REMOTE_REVIEW",
            reasonCode: "X",
            when: [{ fact: "underwritingScore", op: "gte", value: 1 }],
          },
        ],
      }),
    ).toThrow(/condition/);
    expect(() => parseInterventionPolicy({ ...raw, rules: [...raw.rules, raw.rules[0]] })).toThrow(
      /rule/,
    );
  });
});

describe("evaluation", () => {
  it.each<[string, Partial<InterventionFacts>, string]>([
    ["calm open case", {}, "REMOTE_MONITORING"],
    [
      "verified improved, trusted, stable",
      {
        caseState: "VERIFIED_IMPROVED",
        caseUnresolved: false,
        latestVerificationResult: "VERIFIED",
      },
      "REMOTE_MONITORING",
    ],
    [
      "latest verification not improving",
      {
        latestVerificationResult: "NOT_IMPROVING",
        notImprovingCount: 1,
        consecutiveUnsuccessfulVerifications: 1,
      },
      "REMOTE_REVIEW",
    ],
    [
      "latest verification partial",
      {
        latestVerificationResult: "PARTIALLY_VERIFIED",
        partiallyVerifiedCount: 1,
        consecutiveUnsuccessfulVerifications: 1,
      },
      "REMOTE_REVIEW",
    ],
    ["high severity unresolved", { caseSeverity: "HIGH" }, "REMOTE_REVIEW"],
    ["acknowledgement escalated", { escalated: true }, "REMOTE_REVIEW"],
    ["integrity issue", { integrityIssue: true }, "REMOTE_REVIEW"],
    [
      "two unsuccessful in a row",
      { consecutiveUnsuccessfulVerifications: 2, latestVerificationResult: "NOT_IMPROVING" },
      "RISK_ENGINEER_REVIEW",
    ],
    [
      "repeated inconclusive",
      { inconclusiveCount: 2, latestVerificationResult: "INCONCLUSIVE" },
      "RISK_ENGINEER_REVIEW",
    ],
    ["recurred once", { recurrenceCount: 1 }, "RISK_ENGINEER_REVIEW"],
    [
      "critical and not improving",
      { caseSeverity: "CRITICAL", latestVerificationResult: "NOT_IMPROVING" },
      "RISK_ENGINEER_REVIEW",
    ],
    ["recurred twice", { recurrenceCount: 2 }, "SITE_VISIT_RECOMMENDED"],
    [
      "three unsuccessful in a row",
      { consecutiveUnsuccessfulVerifications: 3 },
      "SITE_VISIT_RECOMMENDED",
    ],
    [
      "critical unresolved with insufficient remote evidence",
      { caseSeverity: "CRITICAL", insufficientRemoteEvidence: true },
      "SITE_VISIT_RECOMMENDED",
    ],
  ])("%s => %s", (_n, over, level) => {
    expect(evaluateInterventionPolicy(policy, facts(over)).level).toBe(level);
  });

  it("insufficient remote evidence alone justifies human review (never silently confidence)", () => {
    const d = evaluateInterventionPolicy(policy, facts({ insufficientRemoteEvidence: true }));
    expect(d.level).toBe("REMOTE_REVIEW");
    expect(d.reasonCodes).toContain("INSUFFICIENT_REMOTE_EVIDENCE");
  });

  it("exposes every matching reason, takes the highest level, and is order independent", () => {
    const f = facts({ recurrenceCount: 1, escalated: true, caseSeverity: "HIGH" });
    const a = evaluateInterventionPolicy(policy, f);
    expect(a.level).toBe("RISK_ENGINEER_REVIEW");
    expect(a.reasonCodes).toEqual(
      expect.arrayContaining([
        "RECURRED_AFTER_VERIFIED_IMPROVEMENT",
        "ACKNOWLEDGEMENT_ESCALATED",
        "HIGH_SEVERITY_UNRESOLVED",
      ]),
    );
    const reversed = { ...policy, rules: [...policy.rules].reverse() };
    expect(evaluateInterventionPolicy(reversed, f).level).toBe(a.level);
    expect(evaluateInterventionPolicy(policy, f)).toEqual(a);
  });

  it("the default carries a reason code", () => {
    expect(evaluateInterventionPolicy(policy, calm).reasonCodes).toEqual([
      "NO_ESCALATION_CONDITION_MET",
    ]);
  });
});

const baseCase: RiskImprovementCase = {
  caseId: "CASE-1",
  organizationId: "ORG-SIM-001",
  facilityId: "FAC-SIM-001",
  assetIds: ["AST-1"],
  origin: { type: "DETECTED_HAZARD", detectionId: "D" },
  hazardType: "H",
  title: "t",
  severity: "MODERATE",
  activeRiskEventId: "RE-1",
  state: "OPEN",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const attempt = (
  id: string,
  result: "VERIFIED" | "NOT_IMPROVING" | "INCONCLUSIVE",
  at: number,
): VerificationAttempt => ({
  verificationId: id,
  organizationId: "ORG-SIM-001",
  facilityId: "FAC-SIM-001",
  caseId: "CASE-1",
  eventId: "RE-1",
  policyId: "P",
  policyVersion: "1",
  actionIds: [],
  actionLibraryIds: [],
  postActionWindow: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-01T00:02:00.000Z" },
  requiredAssetIds: [],
  requiredSignals: [],
  startedAt: "2026-10-01T00:00:00.000Z",
  correlationId: "C",
  status: "COMPLETED",
  evaluatedAt: new Date(Date.parse("2026-10-01T01:00:00.000Z") + at * 1000).toISOString(),
  assessment: sampleAssessment({
    verificationId: id,
    result,
    dataCompleteness: 0.4,
    reasonCodes: result === "INCONCLUSIVE" ? ["DEVICE_INTEGRITY:X"] : [],
  }),
});

describe("facts are built from persisted records only", () => {
  it("counts outcomes, consecutive failures (reset by a verified result) and integrity issues", () => {
    const b = buildInterventionFacts({
      policy,
      caseRecord: baseCase,
      attempts: [
        attempt("V1", "NOT_IMPROVING", 1),
        attempt("V2", "VERIFIED", 2),
        attempt("V3", "INCONCLUSIVE", 3),
        attempt("V4", "NOT_IMPROVING", 4),
      ],
      audit: [],
    });
    expect(b.facts).toMatchObject({
      notImprovingCount: 2,
      inconclusiveCount: 1,
      consecutiveUnsuccessfulVerifications: 2,
      latestVerificationResult: "NOT_IMPROVING",
      integrityIssue: false,
    });
    expect(b.supportingEvidenceIds).toEqual(["V1", "V2", "V3", "V4"]);
  });

  it("no verification and no detection record means data sufficiency 0, not confidence", () => {
    const b = buildInterventionFacts({ policy, caseRecord: baseCase, attempts: [], audit: [] });
    expect(b.dataSufficiency).toBe(0);
    expect(b.facts.latestVerificationResult).toBe("NONE");
  });

  it("low data sufficiency after a verification is insufficient remote evidence", () => {
    const b = buildInterventionFacts({
      policy,
      caseRecord: baseCase,
      attempts: [attempt("V1", "NOT_IMPROVING", 1)],
      audit: [],
    });
    expect(b.facts.insufficientRemoteEvidence).toBe(true); // completeness 0.4 < 0.6
  });
});

describe("service: supersede, idempotence, resolve, acknowledge", () => {
  async function rig() {
    const clock = new ManualClock(Date.parse("2026-10-01T02:00:00Z"));
    const cases = new InMemoryCaseRepository();
    const verifications = new InMemoryVerificationRepository();
    const interventions = new InMemoryInterventionRepository();
    const bus = new InMemoryBus();
    const audit = new InMemoryAuditLog();
    const deps = {
      bus,
      ids: new SequentialIdGenerator(),
      clock,
      audit,
      cases,
      verifications,
      interventions,
      policy,
    };
    await cases.save(baseCase);
    return {
      ...deps,
      service: createInterventionService(deps),
      directory: createSyntheticActorDirectory(),
    };
  }
  const trigger = { correlationId: "CORR", causationId: null };

  it("creates once, is idempotent, and supersedes (never overwrites) when the result changes", async () => {
    const r = await rig();
    const first = await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    expect(first).toMatchObject({ level: "REMOTE_MONITORING", status: "ACTIVE" });
    await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    expect(await r.interventions.list("ORG-SIM-001")).toHaveLength(1);

    await r.cases.save({ ...baseCase, recurrenceCount: 1, state: "REOPENED" });
    const second = await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    expect(second?.level).toBe("RISK_ENGINEER_REVIEW");
    const all = await r.interventions.list("ORG-SIM-001");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: "SUPERSEDED", supersededBy: second?.interventionId });
    expect(all[0]?.level).toBe("REMOTE_MONITORING"); // history preserved
    const updates = r.bus
      .history()
      .filter((e) => e.event_type === "intervention.recommendation_updated.v1");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.payload).toMatchObject({ previousLevel: "REMOTE_MONITORING" });
  });

  it("a closed case resolves its recommendation and creates no new one", async () => {
    const r = await rig();
    await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    await r.cases.save({ ...baseCase, state: "CLOSED" });
    const resolved = await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    expect(resolved?.status).toBe("RESOLVED");
    expect(await r.interventions.list("ORG-SIM-001")).toHaveLength(1);
  });

  it("acknowledgement is a human act that changes only the recommendation", async () => {
    const r = await rig();
    const rec = await r.service.recalculateForCase("ORG-SIM-001", "CASE-1", trigger);
    const mgr = await r.directory.get("USR-FACILITY-MGR-001");
    const op = await r.directory.get("USR-OPERATOR-001");
    const other = await r.directory.get("USR-OTHER-ORG-MGR-001");
    expect((await r.service.acknowledge(op!, rec!.interventionId)).ok).toBe(false);
    const missing = await r.service.acknowledge(other!, rec!.interventionId);
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
    const ack = await r.service.acknowledge(mgr!, rec!.interventionId);
    expect(ack.ok && ack.value).toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgedBy: "USR-FACILITY-MGR-001",
    });
    const again = await r.service.acknowledge(mgr!, rec!.interventionId);
    expect(!again.ok && again.error.code).toBe("CONFLICT");
    expect((await r.cases.get("ORG-SIM-001", "CASE-1"))?.state).toBe("OPEN");
  });
});
