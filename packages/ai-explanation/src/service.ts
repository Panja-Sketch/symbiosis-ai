import { createHash } from "node:crypto";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import { validateExplanation } from "./validate";
import { ProviderError } from "./types";
import type {
  Explanation,
  ExplanationContext,
  ExplanationGovernanceRecord,
  ExplanationLog,
  ExplanationMeta,
  ExplanationProvider,
  ExplanationResponse,
  FallbackReason,
} from "./types";

export type ExplanationServiceSettings = {
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly timeoutMs: number;
  readonly cacheTtlMs: number;
  readonly fallbackCacheTtlMs: number;
};

export type ExplanationServiceDeps = {
  readonly primary: ExplanationProvider;
  /** Always the deterministic template provider; it is what keeps the product useful without AI. */
  readonly fallback: ExplanationProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly log: ExplanationLog;
  readonly settings: ExplanationServiceSettings;
  /** Why the primary provider is the template one, if it was not chosen (for diagnostics). */
  readonly primaryNote?: FallbackReason;
};

export type ExplainOptions = {
  readonly actorId: string;
  readonly correlationId?: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Maps provider failures to the reason recorded and shown. */
function reasonFor(e: unknown): FallbackReason {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case "TIMEOUT":
        return "TIMEOUT";
      case "QUOTA":
        return "QUOTA";
      case "UNAVAILABLE":
        return "UNAVAILABLE";
      case "AUTH":
        return "AUTH";
      case "MALFORMED":
        return "MALFORMED_OUTPUT";
      case "NOT_CONFIGURED":
        return "NOT_CONFIGURED";
      default:
        return "PROVIDER_ERROR";
    }
  }
  return "PROVIDER_ERROR";
}

/**
 * Orchestrates one explanation: ask the primary provider (bounded by a timeout), validate whatever
 * comes back against the supplied facts, and fall back to the deterministic template on any problem.
 * It never throws, never writes to any domain repository, and keeps only a governance log and a
 * cache. The cache key contains a hash of the exact facts, so an explanation can never outlive the
 * facts (or the authorization that produced them): callers always rebuild the facts through the
 * authorized read path first.
 */
export class ExplanationService {
  private primary: ExplanationProvider;
  private readonly cache = new Map<string, { value: ExplanationResponse; expiresAtMs: number }>();

  constructor(private readonly deps: ExplanationServiceDeps) {
    this.primary = deps.primary;
  }

  /** Swap the primary provider (local development and the browser tests). */
  setPrimary(provider: ExplanationProvider): void {
    this.primary = provider;
    this.cache.clear();
  }

  get primaryName(): string {
    return this.primary.name;
  }

  private key(ctx: ExplanationContext, provider: ExplanationProvider): string {
    const facts = createHash("sha256")
      .update(
        JSON.stringify({ f: ctx.facts, a: ctx.authoritative, u: ctx.unavailable, s: ctx.sources }),
      )
      .digest("hex");
    return [
      ctx.audience,
      ctx.caseId,
      provider.name,
      provider.model ?? "",
      this.deps.settings.promptVersion,
      facts,
    ].join("|");
  }

  async explain(ctx: ExplanationContext, options: ExplainOptions): Promise<ExplanationResponse> {
    const { settings, clock, ids } = this.deps;
    const correlationId = options.correlationId ?? ids.next("CORR");
    const started = clock.nowMs();
    const primary = this.primary;
    const factIds = ctx.facts.map((f) => f.id);
    const sourceIds = ctx.sources.map((s) => s.id);

    const cacheKey = this.key(ctx, primary);
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined && hit.expiresAtMs > started) {
      this.record({
        ctx,
        options,
        correlationId,
        provider: hit.value.meta.provider,
        ...(hit.value.meta.model !== undefined && { model: hit.value.meta.model }),
        validation: "VALID",
        fallbackUsed: hit.value.meta.fallbackUsed,
        ...(hit.value.meta.fallbackReason !== undefined && {
          fallbackReason: hit.value.meta.fallbackReason,
        }),
        latencyMs: 0,
        cached: true,
        factIds,
        sourceIds,
      });
      return { ...hit.value, meta: { ...hit.value.meta, correlationId, cached: true } };
    }

    let accepted: { explanation: Explanation; provider: ExplanationProvider } | undefined;
    let reason: FallbackReason | undefined;
    let validationCode: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;

    if (primary.name === this.deps.fallback.name) {
      reason = this.deps.primaryNote;
    }
    const attempt = async (provider: ExplanationProvider) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError("TIMEOUT", "the explanation provider timed out"));
        }, settings.timeoutMs);
      });
      try {
        return await Promise.race([
          provider.generate({
            context: ctx,
            promptVersion: settings.promptVersion,
            schemaVersion: settings.schemaVersion,
            signal: controller.signal,
          }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    try {
      const out = await attempt(primary);
      usage = out.usage;
      const v = validateExplanation(out.output, ctx);
      if (v.ok) {
        accepted = { explanation: v.value, provider: primary };
      } else {
        reason = v.code === "SCHEMA" ? "MALFORMED_OUTPUT" : "VALIDATION_FAILED";
        validationCode = v.code;
      }
    } catch (e) {
      reason = reasonFor(e);
    }

    let fallbackUsed = false;
    if (accepted === undefined) {
      fallbackUsed = true;
      // The template is validated like any provider; if even that fails it is a defect, and the page still gets safe text.
      const t = await this.deps.fallback.generate({
        context: ctx,
        promptVersion: settings.promptVersion,
        schemaVersion: settings.schemaVersion,
        signal: new AbortController().signal,
      });
      const v = validateExplanation(t.output, ctx);
      accepted = {
        explanation: v.ok
          ? v.value
          : {
              summary:
                "An explanation could not be generated. The system facts shown on this page are authoritative.",
              keyFacts: [],
              whyItMatters: [],
              actionContext: [],
              verificationExplanation: [],
              interventionExplanation: [],
              evidenceExplanation: [],
              limitations: ["The explanation could not be generated from the supplied facts."],
              sourceFactIds: factIds.slice(0, 1),
            },
        provider: this.deps.fallback,
      };
      if (!v.ok) validationCode = `TEMPLATE_${v.code}`;
    }

    const finished = clock.nowMs();
    const meta: ExplanationMeta = {
      provider: accepted.provider.name,
      ...(accepted.provider.model !== undefined && { model: accepted.provider.model }),
      generatedAt: iso(finished),
      promptVersion: settings.promptVersion,
      schemaVersion: settings.schemaVersion,
      audience: ctx.audience,
      caseId: ctx.caseId,
      sources: ctx.sources,
      fallbackUsed: fallbackUsed || reason !== undefined,
      ...(reason !== undefined && { fallbackReason: reason }),
      ...(fallbackUsed &&
        primary.name !== this.deps.fallback.name && { attemptedProvider: primary.name }),
      correlationId,
      cached: false,
    };
    const response: ExplanationResponse = {
      explanation: accepted.explanation,
      meta,
      facts: ctx.facts,
    };

    const ttl = meta.fallbackUsed ? settings.fallbackCacheTtlMs : settings.cacheTtlMs;
    if (ttl > 0) this.cache.set(cacheKey, { value: response, expiresAtMs: finished + ttl });

    this.record({
      ctx,
      options,
      correlationId,
      provider: accepted.provider.name,
      ...(accepted.provider.model !== undefined && { model: accepted.provider.model }),
      validation: validationCode === undefined ? "VALID" : "REJECTED",
      ...(validationCode !== undefined && { validationCode }),
      fallbackUsed: meta.fallbackUsed,
      ...(reason !== undefined && { fallbackReason: reason }),
      latencyMs: Math.max(0, finished - started),
      cached: false,
      factIds,
      sourceIds,
      ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
    });
    return response;
  }

  private record(r: {
    ctx: ExplanationContext;
    options: ExplainOptions;
    correlationId: string;
    provider: string;
    model?: string;
    validation: "VALID" | "REJECTED" | "NOT_RUN";
    validationCode?: string;
    fallbackUsed: boolean;
    fallbackReason?: FallbackReason;
    latencyMs: number;
    cached: boolean;
    factIds: readonly string[];
    sourceIds: readonly string[];
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    const { settings, clock, ids, log } = this.deps;
    const rec: ExplanationGovernanceRecord = {
      recordId: ids.next("EXPL"),
      at: iso(clock.nowMs()),
      caseId: r.ctx.caseId,
      audience: r.ctx.audience,
      actorId: r.options.actorId,
      useCases: ["CASE_SUMMARY", "VERIFICATION", "INTERVENTION", "EVIDENCE"],
      provider: r.provider,
      ...(r.model !== undefined && { model: r.model }),
      promptVersion: settings.promptVersion,
      schemaVersion: settings.schemaVersion,
      sourceIds: r.sourceIds,
      factIds: r.factIds,
      validation: r.validation,
      ...(r.validationCode !== undefined && { validationCode: r.validationCode }),
      fallbackUsed: r.fallbackUsed,
      ...(r.fallbackReason !== undefined && { fallbackReason: r.fallbackReason }),
      latencyMs: r.latencyMs,
      ...(r.inputTokens !== undefined && { inputTokens: r.inputTokens }),
      ...(r.outputTokens !== undefined && { outputTokens: r.outputTokens }),
      cached: r.cached,
      correlationId: r.correlationId,
    };
    try {
      log.append(rec);
    } catch {
      // The governance log must never break an explanation; the page still renders.
    }
  }
}
