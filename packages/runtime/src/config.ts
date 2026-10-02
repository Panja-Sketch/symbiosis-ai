import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseActionLibrary } from "@symbiosis/action-orchestration";
import type { ActionLibrary } from "@symbiosis/action-orchestration";
import { resolveExplanationConfig } from "@symbiosis/ai-explanation";
import { parseBaselineConfig } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { parseDataQualityConfig } from "@symbiosis/data-quality";
import { parseEscalationPolicy } from "@symbiosis/escalation";
import type { EscalationPolicy } from "@symbiosis/escalation";
import { parseInterventionPolicy } from "@symbiosis/intervention-prioritization";
import type { InterventionPolicy } from "@symbiosis/intervention-prioritization";
import type { SourceMappingDefinition } from "@symbiosis/contracts";
import { parseSourceMapping } from "@symbiosis/normalization";
import { parseFollowUpPolicy } from "@symbiosis/notifications";
import type { FollowUpPolicy } from "@symbiosis/notifications";
import { parseFacilityModel, parseScenarios } from "@symbiosis/simulation";
import { parseRuleConfig } from "@symbiosis/risk-detection";
import type { RuleConfig } from "@symbiosis/risk-detection";
import { parseVerificationPolicy } from "@symbiosis/verification";
import type { VerificationPolicy } from "@symbiosis/verification";
import { parsePolicyParameters } from "./simulation-policy";

/**
 * Runtime selection and validation (S9).
 *
 * `SYMBIOSIS_RUNTIME` picks the adapter family:
 *   local     in-memory everything, demo identity (unit tests, `pnpm dev`, S2-S8 smokes);
 *   emulator  Firestore repositories on the Firestore emulator, in-memory bus/store/keys, demo
 *             identity (integration tests only; refuses to run on Cloud Run);
 *   gcp       Firestore, Pub/Sub, Cloud Storage, Secret Manager, Firebase Auth, Vertex via ADC.
 *
 * There is no silent fallback: in `gcp` every required setting must be present and valid or startup
 * throws a `RuntimeConfigError` naming what is wrong (never a value). Running on Cloud Run
 * (`K_SERVICE` set) with any runtime other than `gcp` is refused, so a missing variable can never
 * turn a deployment into an in-memory one.
 */
export type RuntimeMode = "local" | "emulator" | "gcp";
export type ServiceRole = "api" | "worker";

export type Env = Readonly<Record<string, string | undefined>>;

export class RuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid runtime configuration: ${problems.join("; ")}`);
    this.name = "RuntimeConfigError";
  }
}

export type GcpConfig = {
  readonly mode: "gcp";
  readonly projectId: string;
  readonly region: string;
  readonly topic: string;
  readonly evidenceBucket: string;
  readonly firebaseProjectId: string;
  /** Verify that a token has not been revoked (extra Identity Toolkit call per verification). */
  readonly checkRevokedTokens: boolean;
  readonly collectionPrefix: string;
  readonly version: string;
  /** Worker only: who may deliver pushes / ticks and the audience their tokens carry. */
  readonly worker?: {
    readonly audience: string;
    readonly pushServiceAccount: string;
    readonly schedulerServiceAccount: string;
  };
};
export type LocalConfig = { readonly mode: "local"; readonly version: string };
export type EmulatorConfig = {
  readonly mode: "emulator";
  readonly projectId: string;
  readonly emulatorHost: string;
  readonly collectionPrefix: string;
  readonly version: string;
};
export type RuntimeConfig = LocalConfig | EmulatorConfig | GcpConfig;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMAIL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}$/;

export function parseRuntimeConfig(env: Env, role: ServiceRole): RuntimeConfig {
  const version = env.SYMBIOSIS_VERSION ?? env.K_REVISION ?? "dev";
  const requested = env.SYMBIOSIS_RUNTIME ?? "";
  const onCloudRun = (env.K_SERVICE ?? "") !== "";
  const problems: string[] = [];

  if (
    requested !== "" &&
    requested !== "local" &&
    requested !== "emulator" &&
    requested !== "gcp"
  ) {
    throw new RuntimeConfigError(["SYMBIOSIS_RUNTIME must be local, emulator or gcp"]);
  }
  if (onCloudRun && requested !== "gcp") {
    throw new RuntimeConfigError([
      "running on Cloud Run requires SYMBIOSIS_RUNTIME=gcp (no fallback to local adapters)",
    ]);
  }
  const mode: RuntimeMode = requested === "" ? "local" : requested;

  if (mode === "local") return { mode, version };

  if (mode === "emulator") {
    const emulatorHost = env.FIRESTORE_EMULATOR_HOST ?? "";
    if (emulatorHost === "") problems.push("FIRESTORE_EMULATOR_HOST is required in emulator mode");
    if (problems.length > 0) throw new RuntimeConfigError(problems);
    return {
      mode,
      projectId: env.GCP_PROJECT_ID ?? "demo-symbiosis",
      emulatorHost,
      collectionPrefix: env.SYMBIOSIS_COLLECTION_PREFIX ?? "",
      version,
    };
  }

  const need = (name: string, pattern: RegExp): string => {
    const v = env[name] ?? "";
    if (v === "") problems.push(`${name} is required`);
    else if (!pattern.test(v)) problems.push(`${name} has an invalid format`);
    return v;
  };
  const projectId = need("GCP_PROJECT_ID", PROJECT);
  const region = need("GCP_REGION", NAME);
  const topic = need("SYMBIOSIS_EVENTS_TOPIC", NAME);
  const evidenceBucket = need("SYMBIOSIS_EVIDENCE_BUCKET", /^[a-z0-9][a-z0-9._-]{2,221}$/);
  const firebaseProjectId = need("FIREBASE_PROJECT_ID", PROJECT);
  if ((env.FIRESTORE_EMULATOR_HOST ?? "") !== "") {
    problems.push("FIRESTORE_EMULATOR_HOST must not be set in gcp mode");
  }
  if ((env.FIREBASE_AUTH_EMULATOR_HOST ?? "") !== "") {
    problems.push("FIREBASE_AUTH_EMULATOR_HOST must not be set in gcp mode");
  }
  if ((env.VERTEX_ACCESS_TOKEN ?? "") !== "") {
    problems.push(
      "VERTEX_ACCESS_TOKEN must not be set in gcp mode (Vertex uses the runtime service identity)",
    );
  }
  if ((env.SYMBIOSIS_ALLOW_DEMO_IDENTITY ?? "") !== "") {
    problems.push("demo identity cannot be enabled in gcp mode");
  }
  let worker: GcpConfig["worker"];
  if (role === "worker") {
    const audience = need("SYMBIOSIS_WORKER_AUDIENCE", /^https:\/\/\S+$/);
    const pushServiceAccount = need("SYMBIOSIS_PUSH_SERVICE_ACCOUNT", EMAIL);
    const schedulerServiceAccount = need("SYMBIOSIS_SCHEDULER_SERVICE_ACCOUNT", EMAIL);
    worker = { audience, pushServiceAccount, schedulerServiceAccount };
  }
  if (problems.length > 0) throw new RuntimeConfigError(problems);
  return {
    mode: "gcp",
    projectId,
    region,
    topic,
    evidenceBucket,
    firebaseProjectId,
    checkRevokedTokens: env.SYMBIOSIS_CHECK_REVOKED !== "false",
    collectionPrefix: env.SYMBIOSIS_COLLECTION_PREFIX ?? "",
    version,
    ...(worker !== undefined && { worker }),
  };
}

/** Directory holding the versioned JSON config (config/). Overridable for container images. */
export function configDir(env: Env = process.env): string {
  return env.SYMBIOSIS_CONFIG_DIR ?? join(import.meta.dirname, "..", "..", "..", "config");
}

const readJson = (relative: string, env?: Env): unknown =>
  JSON.parse(readFileSync(join(configDir(env), relative), "utf8"));

export const loadDataQualityConfig = (env?: Env) =>
  parseDataQualityConfig(readJson("rules/data-quality.v1.json", env));
export const loadBaselineConfig = (env?: Env): BaselineConfig =>
  parseBaselineConfig(readJson("rules/baselines.v1.json", env));
export const loadRuleConfig = (env?: Env): RuleConfig =>
  parseRuleConfig(readJson("rules/cooling-electrical.v1.json", env));
export const loadEscalationPolicy = (env?: Env): EscalationPolicy =>
  parseEscalationPolicy(readJson("escalation/escalation.v1.json", env));
export const loadVerificationPolicy = (env?: Env): VerificationPolicy =>
  parseVerificationPolicy(readJson("verification-policy/cooling-electrical.v1.json", env));
export const loadInterventionPolicy = (env?: Env): InterventionPolicy =>
  parseInterventionPolicy(
    readJson("intervention-policy/risk-engineer-prioritization.v1.json", env),
  );
export const loadActionLibrary = (env?: Env): ActionLibrary =>
  parseActionLibrary(readJson("action-library/cooling-actions.v1.json", env));
export const loadExplanationConfig = (env: Env = process.env) =>
  resolveExplanationConfig(readJson("explanation/explanation.v1.json", env), env);

/** Production files exactly as read, before any simulation override (D-092). */
export const loadRawPolicyBase = (env?: Env) => ({
  rule: readJson("rules/cooling-electrical.v1.json", env),
  baseline: readJson("rules/baselines.v1.json", env),
  dataQuality: readJson("rules/data-quality.v1.json", env),
  verification: readJson("verification-policy/cooling-electrical.v1.json", env),
  escalation: readJson("escalation/escalation.v1.json", env),
  followUp: readJson("notifications/follow-up.v1.json", env),
});
export const loadFollowUpPolicy = (env?: Env): FollowUpPolicy =>
  parseFollowUpPolicy(readJson("notifications/follow-up.v1.json", env));
export const loadPolicyParameters = (env?: Env) =>
  parsePolicyParameters(readJson("simulation/policy.v1.json", env));
export const loadSimulationFacility = (env?: Env) =>
  parseFacilityModel(readJson("simulation/facility.v1.json", env));
export const loadScenarios = (env?: Env) =>
  parseScenarios(readJson("simulation/scenarios.v1.json", env));
export const loadAdapterProfiles = (env?: Env): SourceMappingDefinition[] =>
  ["sim-bas-gateway", "sim-hvac-controller", "sim-vibration-gateway", "sim-electrical-meter"].map(
    (id) => {
      const parsed = parseSourceMapping(readJson(`adapters/${id}.v1.json`, env));
      if (!parsed.ok) throw new Error(`invalid adapter profile ${id}: ${parsed.issues.join("; ")}`);
      return parsed.value;
    },
  );
