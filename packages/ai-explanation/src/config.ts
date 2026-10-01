import { GeminiExplanationProvider } from "./gemini";
import type { AccessTokenProvider, FetchLike, GeminiConfig } from "./gemini";
import { TemplateExplanationProvider } from "./template";
import type { ExplanationProvider, FallbackReason } from "./types";

/**
 * Explanation configuration (S8). The model name, region, timeouts and cache lifetimes live in the
 * versioned file `config/explanation/explanation.v1.json`; a few values can be overridden from the
 * environment. No secret is stored in config: the access token is read from the environment at call
 * time in local mode; in the cloud (S9) the caller passes a workload-identity token supplier instead. The default provider is the
 * deterministic template, so nothing depends on Gemini unless it is switched on.
 */

export type ExplanationConfig = {
  readonly schemaVersion: "explanation-config.v1";
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly provider: "template" | "gemini";
  readonly gemini: {
    readonly model: string;
    readonly location: string;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  };
  readonly cache: { readonly ttlSeconds: number; readonly fallbackTtlSeconds: number };
};

export type Env = Readonly<Record<string, string | undefined>>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "")
    throw new Error(`explanation config: ${name} must be a non-empty string`);
  return v;
};
const num = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`explanation config: ${name} must be a number between ${min} and ${max}`);
  }
  return v;
};

/** Fail-closed parsing of the config file, then environment overrides. */
export function resolveExplanationConfig(file: unknown, env: Env = {}): ExplanationConfig {
  const o = (file ?? {}) as Record<string, unknown>;
  if (o.schemaVersion !== "explanation-config.v1")
    throw new Error("explanation config: unsupported schemaVersion");
  const g = (o.gemini ?? {}) as Record<string, unknown>;
  const c = (o.cache ?? {}) as Record<string, unknown>;
  const fileProvider = o.provider;
  if (fileProvider !== "template" && fileProvider !== "gemini") {
    throw new Error("explanation config: provider must be template or gemini");
  }
  const envProvider = env.SYMBIOSIS_AI_PROVIDER;
  if (
    envProvider !== undefined &&
    envProvider !== "" &&
    envProvider !== "template" &&
    envProvider !== "gemini"
  ) {
    throw new Error("SYMBIOSIS_AI_PROVIDER must be template or gemini");
  }
  return {
    schemaVersion: "explanation-config.v1",
    promptVersion: str(o.promptVersion, "promptVersion"),
    outputSchemaVersion: str(o.outputSchemaVersion, "outputSchemaVersion"),
    provider: envProvider === "template" || envProvider === "gemini" ? envProvider : fileProvider,
    gemini: {
      model:
        env.GEMINI_MODEL !== undefined && env.GEMINI_MODEL !== ""
          ? env.GEMINI_MODEL
          : str(g.model, "gemini.model"),
      // GEMINI_LOCATION (S9) wins: a model may be served only from a different location than the
      // project region. GCP_REGION is the S8 override and is kept.
      location:
        env.GEMINI_LOCATION !== undefined && env.GEMINI_LOCATION !== ""
          ? env.GEMINI_LOCATION
          : env.GCP_REGION !== undefined && env.GCP_REGION !== ""
            ? env.GCP_REGION
            : str(g.location, "gemini.location"),
      temperature: num(g.temperature, "gemini.temperature", 0, 1),
      maxOutputTokens: num(g.maxOutputTokens, "gemini.maxOutputTokens", 64, 8192),
      timeoutMs: num(g.timeoutMs, "gemini.timeoutMs", 100, 60000),
    },
    cache: {
      ttlSeconds: num(c.ttlSeconds, "cache.ttlSeconds", 0, 86400),
      fallbackTtlSeconds: num(c.fallbackTtlSeconds, "cache.fallbackTtlSeconds", 0, 3600),
    },
  };
}

export type ProviderSelection = {
  readonly primary: ExplanationProvider;
  readonly fallback: ExplanationProvider;
  /** Set when Gemini was requested but could not be set up, so the template is the primary. */
  readonly note?: FallbackReason;
};

/**
 * Chooses the primary provider. `gemini` needs a project id and an access token in the environment;
 * if either is missing the template becomes the primary and the reason is reported, never an error.
 */
export function selectProvider(
  config: ExplanationConfig,
  env: Env = {},
  fetchImpl?: FetchLike,
  /** Production: a workload-identity token supplier (ADC). Replaces the local VERTEX_ACCESS_TOKEN. */
  tokenProvider?: AccessTokenProvider,
): ProviderSelection {
  const fallback = new TemplateExplanationProvider();
  if (config.provider === "template") return { primary: fallback, fallback };
  const projectId = env.GCP_PROJECT_ID ?? "";
  if (projectId === "" || (tokenProvider === undefined && (env.VERTEX_ACCESS_TOKEN ?? "") === "")) {
    return { primary: fallback, fallback, note: "NOT_CONFIGURED" };
  }
  const gemini: GeminiConfig = {
    projectId,
    location: config.gemini.location,
    model: config.gemini.model,
    temperature: config.gemini.temperature,
    maxOutputTokens: config.gemini.maxOutputTokens,
    timeoutMs: config.gemini.timeoutMs,
  };
  return {
    primary: new GeminiExplanationProvider(
      gemini,
      tokenProvider ?? (async () => env.VERTEX_ACCESS_TOKEN ?? ""),
      fetchImpl,
    ),
    fallback,
  };
}
