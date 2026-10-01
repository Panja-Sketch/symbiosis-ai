import { INTERVENTION_LEVELS } from "@symbiosis/contracts";
import type { InterventionFacts, InterventionLevel } from "@symbiosis/contracts";

export const INTERVENTION_POLICY_SCHEMA = "intervention-policy.v1" as const;

/** The only facts a rule may read: trusted, explainable, never personal and never generated. */
export const FACT_NAMES = [
  "caseSeverity",
  "caseState",
  "caseUnresolved",
  "latestVerificationResult",
  "notImprovingCount",
  "partiallyVerifiedCount",
  "inconclusiveCount",
  "consecutiveUnsuccessfulVerifications",
  "recurrenceCount",
  "escalated",
  "dataSufficiency",
  "telemetryConfidence",
  "integrityIssue",
  "corroboratingSignals",
  "insufficientRemoteEvidence",
] as const satisfies readonly (keyof InterventionFacts)[];
export type FactName = (typeof FACT_NAMES)[number];

export const OPERATORS = ["eq", "neq", "gte", "lte", "gt", "lt"] as const;
export type Operator = (typeof OPERATORS)[number];

export type Condition = {
  readonly fact: FactName;
  readonly op: Operator;
  readonly value: string | number | boolean;
};

export type InterventionRule = {
  readonly ruleId: string;
  readonly level: InterventionLevel;
  readonly reasonCode: string;
  /** Every condition must hold. */
  readonly when: readonly Condition[];
};

export type InterventionPolicy = {
  readonly schema: typeof INTERVENTION_POLICY_SCHEMA;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly dataSufficiency: { readonly minimumForRemoteConfidence: number };
  readonly rules: readonly InterventionRule[];
  readonly default: { readonly level: InterventionLevel; readonly reasonCode: string };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isLevel = (v: unknown): v is InterventionLevel =>
  (INTERVENTION_LEVELS as readonly unknown[]).includes(v);

/** Parses and validates the policy; anything malformed or unsupported throws (fails closed). */
export function parseInterventionPolicy(value: unknown): InterventionPolicy {
  if (!isRecord(value)) throw new Error("invalid intervention policy: not an object");
  if (value.schema !== INTERVENTION_POLICY_SCHEMA) {
    throw new Error(`unsupported intervention policy schema: ${String(value.schema)}`);
  }
  const ds = value.dataSufficiency;
  const def = value.default;
  if (
    !isText(value.policyId) ||
    !isText(value.policyVersion) ||
    !isRecord(ds) ||
    typeof ds.minimumForRemoteConfidence !== "number" ||
    ds.minimumForRemoteConfidence < 0 ||
    ds.minimumForRemoteConfidence > 1 ||
    !Array.isArray(value.rules) ||
    !isRecord(def) ||
    !isLevel(def.level) ||
    !isText(def.reasonCode)
  ) {
    throw new Error("invalid intervention policy");
  }
  const ids = new Set<string>();
  const rules: InterventionRule[] = value.rules.map((r: unknown) => {
    if (
      !isRecord(r) ||
      !isText(r.ruleId) ||
      ids.has(r.ruleId) ||
      !isLevel(r.level) ||
      !isText(r.reasonCode) ||
      !Array.isArray(r.when) ||
      r.when.length === 0
    ) {
      throw new Error("invalid intervention policy: rule");
    }
    ids.add(r.ruleId);
    const when: Condition[] = r.when.map((c: unknown) => {
      if (
        !isRecord(c) ||
        !(FACT_NAMES as readonly unknown[]).includes(c.fact) ||
        !(OPERATORS as readonly unknown[]).includes(c.op) ||
        !["string", "number", "boolean"].includes(typeof c.value)
      ) {
        throw new Error(`invalid intervention policy: condition in ${r.ruleId}`);
      }
      return {
        fact: c.fact as FactName,
        op: c.op as Operator,
        value: c.value as string | number | boolean,
      };
    });
    return { ruleId: r.ruleId, level: r.level, reasonCode: r.reasonCode, when };
  });
  return {
    schema: INTERVENTION_POLICY_SCHEMA,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    dataSufficiency: { minimumForRemoteConfidence: ds.minimumForRemoteConfidence },
    rules,
    default: { level: def.level, reasonCode: def.reasonCode },
  };
}
