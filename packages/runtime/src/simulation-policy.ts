import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import { parseBaselineConfig } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import type { DataQualityConfig } from "@symbiosis/data-quality";
import { parseEscalationPolicy } from "@symbiosis/escalation";
import type { EscalationPolicy } from "@symbiosis/escalation";
import { parseFollowUpPolicy } from "@symbiosis/notifications";
import type { FollowUpPolicy } from "@symbiosis/notifications";
import type { TenantDocumentStore } from "@symbiosis/repositories";
import { parseRuleConfig } from "@symbiosis/risk-detection";
import type { RuleConfig } from "@symbiosis/risk-detection";
import { parseVerificationPolicy } from "@symbiosis/verification";
import type { VerificationPolicy } from "@symbiosis/verification";

/**
 * DEMO / SIMULATION POLICY (S10, D-092). The simulation tenant judges risk under a versioned,
 * bounded variant of the production configuration: shorter windows and a weather-compatible context
 * age, so a demonstration takes minutes and an evaluator can see thresholds move. It is NOT the
 * production or insurer policy: production files are never edited and every other tenant still
 * resolves them. Every change creates a new immutable version with who, when and why; a case keeps
 * the version it was judged under.
 *
 * Safety: a version is the production configuration plus bounded numeric overrides at fixed paths;
 * the result is re-parsed by the same fail-closed parsers production uses, so anything those would
 * refuse (weakening authentication, a non-required vibration criterion...) is refused here too.
 */
export const SIM_POLICY_SCHEMA = "simulation-policy.v1" as const;

export const POLICY_TARGETS = [
  "rule",
  "baseline",
  "dataQuality",
  "verification",
  "escalation",
  "followUp",
] as const;
export type PolicyTarget = (typeof POLICY_TARGETS)[number];

export type PolicyParameter = {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly target: PolicyTarget;
  readonly path: string;
  readonly unit: string;
  readonly operator: string;
  readonly role: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly integer: boolean;
  readonly signal?: string;
};

export type PolicyParameters = {
  readonly label: string;
  readonly note: string;
  readonly parameters: readonly PolicyParameter[];
};

export type PolicyValues = Readonly<Record<string, number>>;

/** The parsed configurations the simulation tenant resolves. */
export type PolicyBundle = {
  readonly version: number;
  readonly label: string;
  readonly rule: RuleConfig;
  readonly baseline: BaselineConfig;
  readonly dataQuality: DataQualityConfig;
  readonly verification: VerificationPolicy;
  readonly escalation: EscalationPolicy;
  readonly followUp: FollowUpPolicy;
};

/** The production files exactly as read from config/, before any override. */
export type RawPolicyBase = Readonly<Record<PolicyTarget, unknown>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parsePolicyParameters(value: unknown): PolicyParameters {
  const fail = (why: string): never => {
    throw new Error(`invalid simulation policy parameters: ${why}`);
  };
  if (!isRecord(value) || value.schema !== SIM_POLICY_SCHEMA || !Array.isArray(value.parameters)) {
    return fail("schema");
  }
  const ids = new Set<string>();
  const out: PolicyParameter[] = [];
  for (const p of value.parameters as unknown[]) {
    if (!isRecord(p)) return fail("parameter");
    const id = p.id;
    if (typeof id !== "string" || !/^[a-zA-Z]+(\.[A-Za-z]+)+$/.test(id) || ids.has(id))
      fail(`id ${String(id)}`);
    ids.add(id as string);
    if (!(POLICY_TARGETS as readonly unknown[]).includes(p.target)) fail(`${String(id)}.target`);
    if (
      typeof p.path !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(p.path)
    )
      fail(`${String(id)}.path`);
    for (const k of ["min", "max", "step", "default"] as const) {
      if (typeof p[k] !== "number" || !Number.isFinite(p[k])) fail(`${String(id)}.${k}`);
    }
    if (
      (p.min as number) >= (p.max as number) ||
      (p.default as number) < (p.min as number) ||
      (p.default as number) > (p.max as number)
    ) {
      fail(`${String(id)} bounds`);
    }
    for (const k of ["group", "label", "description", "unit", "operator", "role"] as const) {
      if (typeof p[k] !== "string" || p[k] === "") fail(`${String(id)}.${k}`);
    }
    out.push(p as unknown as PolicyParameter);
  }
  if (out.length === 0) fail("no parameters");
  return { label: String(value.label), note: String(value.note), parameters: out };
}

export const defaultValues = (p: PolicyParameters): PolicyValues =>
  Object.fromEntries(p.parameters.map((x) => [x.id, x.default]));

const SAMPLE_SECONDS = 5;

/** Bounds, type and cross-field checks. Returns every problem, so an editor can show them all. */
export function checkPolicyValues(
  p: PolicyParameters,
  values: unknown,
  rawBase?: RawPolicyBase,
): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(values)) return ["values must be an object"];
  const known = new Map(p.parameters.map((x) => [x.id, x]));
  for (const k of Object.keys(values)) if (!known.has(k)) issues.push(`unknown setting "${k}"`);
  for (const x of p.parameters) {
    const v = values[x.id];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push(`${x.label} is required and must be a finite number`);
      continue;
    }
    if (v < x.min || v > x.max)
      issues.push(`${x.label} must be between ${x.min} and ${x.max} ${x.unit}`);
    if (x.integer && !Number.isInteger(v)) issues.push(`${x.label} must be a whole number`);
  }
  if (issues.length > 0) return issues;
  const n = (id: string) => values[id] as number;
  if (n("verification.sustainedSeconds") > n("verification.postActionWindowSeconds")) {
    issues.push("The sustained interval cannot be longer than the post-action window.");
  }
  if (
    n("verification.minObservations") >
    Math.floor(n("verification.postActionWindowSeconds") / SAMPLE_SECONDS) + 1
  ) {
    issues.push(
      "Minimum observations cannot be reached in the post-action window at one sample every 5 seconds.",
    );
  }
  if (
    n("verification.sustainedMinObservations") >
    Math.floor(n("verification.sustainedSeconds") / SAMPLE_SECONDS) + 1
  ) {
    issues.push("Sustained minimum samples cannot be reached in the sustained interval.");
  }
  if (
    n("baseline.minObservations") >
    Math.floor(n("baseline.warmUpSeconds") / SAMPLE_SECONDS) + 1
  ) {
    issues.push("Baseline minimum samples cannot be reached in the learning window.");
  }
  if (n("rule.contextMaxAgeSeconds") > n("dataQuality.outdoorStaleAfterSeconds")) {
    issues.push(
      "Context freshness cannot be longer than the outdoor weather freshness window (older readings are untrusted).",
    );
  }
  const sev =
    isRecord(rawBase?.rule) && isRecord((rawBase?.rule as Record<string, unknown>).severity)
      ? ((
          rawBase?.rule as {
            severity: { high?: { vibrationZ?: number; currentDeviationPercent?: number } };
          }
        ).severity.high ?? {})
      : {};
  if (sev.vibrationZ !== undefined && n("rule.vibrationZ") > sev.vibrationZ) {
    issues.push(`Vibration deviation cannot exceed the HIGH-severity level (${sev.vibrationZ}).`);
  }
  if (
    sev.currentDeviationPercent !== undefined &&
    n("rule.currentDeviationPercent") > sev.currentDeviationPercent
  ) {
    issues.push(
      `Current deviation cannot exceed the HIGH-severity level (${sev.currentDeviationPercent}%).`,
    );
  }
  return issues;
}

function setPath(root: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split(".");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    if (part === "__proto__" || part === "constructor" || part === "prototype")
      throw new Error("unsafe path");
    const next = cur[part];
    if (!isRecord(next))
      throw new Error(`policy path ${path} does not exist in the base configuration`);
    cur = next;
  }
  const last = parts[parts.length - 1] as string;
  if (last === "__proto__" || last === "constructor" || last === "prototype")
    throw new Error("unsafe path");
  // Only the per-signal staleness map may gain a key; every other path must already exist.
  if (
    !Object.prototype.hasOwnProperty.call(cur, last) &&
    !path.startsWith("staleAfterSecondsBySignal.")
  ) {
    throw new Error(`policy path ${path} does not exist in the base configuration`);
  }
  cur[last] = value;
}

/** Builds the parsed policies of one version. Throws if any production parser refuses the result. */
export function buildPolicyBundle(
  rawBase: RawPolicyBase,
  p: PolicyParameters,
  values: PolicyValues,
  version: number,
): PolicyBundle {
  const raw = structuredClone(rawBase) as Record<PolicyTarget, Record<string, unknown>>;
  // The per-signal staleness map is new on the data-quality file: create it before writing into it.
  if (raw.dataQuality.staleAfterSecondsBySignal === undefined)
    raw.dataQuality.staleAfterSecondsBySignal = {};
  for (const x of p.parameters) {
    setPath(raw[x.target], x.path, values[x.id] as number);
  }
  const label = `sim.${version}`;
  raw.rule.ruleVersion = label;
  raw.baseline.version = label;
  raw.dataQuality.version = label;
  raw.verification.policyVersion = label;
  raw.escalation.version = label;
  raw.followUp.version = label;
  return {
    version,
    label,
    rule: parseRuleConfig(raw.rule),
    baseline: parseBaselineConfig(raw.baseline),
    dataQuality: parseDataQualityConfig(raw.dataQuality),
    verification: parseVerificationPolicy(raw.verification),
    escalation: parseEscalationPolicy(raw.escalation),
    followUp: parseFollowUpPolicy(raw.followUp),
  };
}

export type PolicyVersionRecord = {
  readonly version: number;
  readonly label: string;
  readonly values: PolicyValues;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly basedOn?: number;
  readonly builtin: boolean;
};

type Pointer = { readonly activeVersion: number; readonly latestVersion: number };

export type PolicyPublishResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false;
      readonly code: "INVALID" | "REASON_REQUIRED";
      readonly issues: readonly string[];
    };

export type SimulationPoliciesDeps = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: TenantDocumentStore;
  readonly audit: AuditLog;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly parameters: PolicyParameters;
  readonly rawBase: RawPolicyBase;
};

const VERSIONS = "simulationPolicyVersions" as const;
const ACTIVE = "simulationPolicyActive" as const;

export function createSimulationPolicies(deps: SimulationPoliciesDeps) {
  const { store, organizationId: org, facilityId: fac, parameters } = deps;
  const cache = new Map<number, PolicyBundle>();
  let activeCache: { atMs: number; bundle: PolicyBundle } | undefined;

  // Fail at startup, not on first use, if the defaults do not build under the production parsers.
  const defaults = defaultValues(parameters);
  const defaultIssues = checkPolicyValues(parameters, defaults, deps.rawBase);
  if (defaultIssues.length > 0)
    throw new Error(`simulation policy defaults are invalid: ${defaultIssues.join("; ")}`);
  buildPolicyBundle(deps.rawBase, parameters, defaults, 1);

  const builtin: PolicyVersionRecord = {
    version: 1,
    label: "sim.1",
    values: defaults,
    createdBy: "SYSTEM",
    createdAt: "1970-01-01T00:00:00.000Z",
    reason: "Built-in DEMO / SIMULATION POLICY defaults",
    builtin: true,
  };

  async function pointer(): Promise<Pointer> {
    return (await store.get<Pointer>(ACTIVE, org, fac)) ?? { activeVersion: 1, latestVersion: 1 };
  }

  async function record(version: number): Promise<PolicyVersionRecord | undefined> {
    if (version === 1) return builtin;
    return store.get<PolicyVersionRecord>(VERSIONS, org, `sim.${version}`);
  }

  async function bundleFor(version: number): Promise<PolicyBundle | undefined> {
    const hit = cache.get(version);
    if (hit !== undefined) return hit;
    const r = await record(version);
    if (r === undefined) return undefined;
    const b = buildPolicyBundle(deps.rawBase, parameters, r.values, version);
    cache.set(version, b);
    return b;
  }

  const changes = (from: PolicyValues, to: PolicyValues): string[] =>
    parameters.parameters
      .filter((x) => from[x.id] !== to[x.id])
      .map((x) => `${x.id}: ${String(from[x.id])} -> ${String(to[x.id])}`);

  return {
    parameters,
    record,
    bundleFor,

    /** The version in force now (a few seconds of caching: changes apply to the next evaluation). */
    async active(): Promise<PolicyBundle> {
      const now = deps.clock.nowMs();
      if (activeCache !== undefined && now - activeCache.atMs < 2000) return activeCache.bundle;
      const p = await pointer();
      const bundle =
        (await bundleFor(p.activeVersion)) ??
        (await bundleFor(1)) ??
        buildPolicyBundle(deps.rawBase, parameters, defaults, 1);
      activeCache = { atMs: now, bundle };
      return bundle;
    },

    async view() {
      const p = await pointer();
      const versions: PolicyVersionRecord[] = [];
      for (let v = 1; v <= p.latestVersion; v += 1) {
        const r = await record(v);
        if (r !== undefined) versions.push(r);
      }
      const active = versions.find((x) => x.version === p.activeVersion) ?? builtin;
      return {
        label: parameters.label,
        note: parameters.note,
        parameters: parameters.parameters,
        active,
        versions,
        defaults,
      };
    },

    /** Validates, stores the next immutable version and makes it the active one. */
    async publish(actorId: string, values: unknown, reason: unknown): Promise<PolicyPublishResult> {
      if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 300) {
        return {
          ok: false,
          code: "REASON_REQUIRED",
          issues: ["a reason (3-300 characters) is required"],
        };
      }
      const issues = checkPolicyValues(parameters, values, deps.rawBase);
      if (issues.length > 0) return { ok: false, code: "INVALID", issues };
      const typed = values as PolicyValues;
      let bundleErr: string | undefined;
      try {
        buildPolicyBundle(deps.rawBase, parameters, typed, 99_999);
      } catch (e) {
        bundleErr = e instanceof Error ? e.message : "policy refused by the production parsers";
      }
      if (bundleErr !== undefined) return { ok: false, code: "INVALID", issues: [bundleErr] };
      const before = (await record((await pointer()).activeVersion)) ?? builtin;
      const delta = changes(before.values, typed);
      if (delta.length === 0)
        return {
          ok: false,
          code: "INVALID",
          issues: ["no setting differs from the active version"],
        };
      const reserved = await store.update<Pointer>(ACTIVE, org, fac, (cur) => {
        const c = cur ?? { activeVersion: 1, latestVersion: 1 };
        return { doc: { ...c, latestVersion: c.latestVersion + 1 } };
      });
      const version = reserved?.latestVersion ?? 2;
      const rec: PolicyVersionRecord = {
        version,
        label: `sim.${version}`,
        values: Object.fromEntries(parameters.parameters.map((x) => [x.id, typed[x.id] as number])),
        createdBy: actorId,
        createdAt: nowIso(deps.clock),
        reason: reason.trim(),
        basedOn: before.version,
        builtin: false,
      };
      await store.put(VERSIONS, org, rec.label, rec, { version });
      await store.update<Pointer>(ACTIVE, org, fac, (cur) =>
        cur === undefined ? undefined : { doc: { ...cur, activeVersion: version } },
      );
      activeCache = undefined;
      await deps.audit.append({
        organizationId: org,
        facilityId: fac,
        actorId,
        actorType: "USER",
        action: "SIMULATION_POLICY_PUBLISHED",
        targetType: "POLICY",
        targetId: rec.label,
        beforeState: before.label,
        afterState: rec.label,
        correlationId: deps.ids.next("CORR"),
        at: rec.createdAt,
        details: { version, reason: rec.reason, changes: delta },
      });
      return { ok: true, version };
    },

    /** Makes an existing version the active one again (a roll back); the history is untouched. */
    async activate(actorId: string, version: number, reason: string): Promise<boolean> {
      if ((await record(version)) === undefined) return false;
      const before = (await pointer()).activeVersion;
      if (before === version) return true;
      await store.update<Pointer>(ACTIVE, org, fac, (cur) => {
        const c = cur ?? { activeVersion: 1, latestVersion: 1 };
        return { doc: { ...c, activeVersion: version } };
      });
      activeCache = undefined;
      await deps.audit.append({
        organizationId: org,
        facilityId: fac,
        actorId,
        actorType: "USER",
        action: "SIMULATION_POLICY_ACTIVATED",
        targetType: "POLICY",
        targetId: `sim.${version}`,
        beforeState: `sim.${before}`,
        afterState: `sim.${version}`,
        correlationId: deps.ids.next("CORR"),
        at: nowIso(deps.clock),
        details: { version, reason: reason.slice(0, 300) },
      });
      return true;
    },
  };
}

export type SimulationPolicies = ReturnType<typeof createSimulationPolicies>;
