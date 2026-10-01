/**
 * The explanation layer's vocabulary (spec section 18, S8). Everything the model may see is a
 * `Fact` that the deterministic system already established; everything it may say comes back as an
 * `Explanation` that is validated against those facts before anyone reads it. Nothing here can
 * change a case, an event, a verification, an intervention, a consent or a package.
 */

export type Audience = "FACILITY" | "INSURER";

/** One established fact: a stable id, a short label and a display value (numbers already formatted). */
export type Fact = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
};

/** Where the facts came from, for provenance. Only records that really exist are listed. */
export type SourceRef = {
  readonly type:
    "CASE" | "RISK_EVENT" | "ACTION" | "VERIFICATION" | "EVIDENCE_PACKAGE" | "INTERVENTION";
  readonly id: string;
  readonly version?: string;
};

/** The structured, authoritative values a validator compares the model's words against. */
export type Authoritative = {
  readonly caseState?: string;
  /** `VERIFIED`, `PARTIALLY_VERIFIED`, `NOT_IMPROVING` or `INCONCLUSIVE` (as the verification engine produced it). */
  readonly verificationResult?: string;
  readonly interventionLevel?: string;
  readonly recurrenceCount?: number;
  readonly sharingState?: string;
};

/** Text typed by a person or imported. It is data, never instructions, and is delimited in the prompt. */
export type UntrustedText = {
  readonly id: string;
  readonly origin: string;
  readonly text: string;
};

export type ExplanationContext = {
  readonly audience: Audience;
  readonly caseId: string;
  readonly facts: readonly Fact[];
  readonly sources: readonly SourceRef[];
  readonly authoritative: Authoritative;
  /** The approved action library entries that exist for this case; no other action may be named. */
  readonly allowedActions: readonly { readonly id: string; readonly title: string }[];
  /** Things that are not available to explain (a section not shared, no verification yet...). */
  readonly unavailable: readonly string[];
  readonly untrusted: readonly UntrustedText[];
};

export const EXPLANATION_SECTIONS = [
  "keyFacts",
  "whyItMatters",
  "actionContext",
  "verificationExplanation",
  "interventionExplanation",
  "evidenceExplanation",
  "limitations",
] as const;
export type ExplanationSection = (typeof EXPLANATION_SECTIONS)[number];

/** The only shape accepted from any provider. Extra keys are rejected, not ignored. */
export type Explanation = {
  readonly summary: string;
  readonly keyFacts: readonly string[];
  readonly whyItMatters: readonly string[];
  readonly actionContext: readonly string[];
  readonly verificationExplanation: readonly string[];
  readonly interventionExplanation: readonly string[];
  readonly evidenceExplanation: readonly string[];
  readonly limitations: readonly string[];
  /** Fact ids the explanation rests on; each must be one of the supplied facts. */
  readonly sourceFactIds: readonly string[];
};

export type FallbackReason =
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "QUOTA"
  | "UNAVAILABLE"
  | "AUTH"
  | "MALFORMED_OUTPUT"
  | "VALIDATION_FAILED"
  | "NOT_CONFIGURED"
  | "DISABLED";

export type ExplanationMeta = {
  /** The provider whose words are shown: `template` or `gemini`. */
  readonly provider: string;
  readonly model?: string;
  readonly generatedAt: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly audience: Audience;
  readonly caseId: string;
  readonly sources: readonly SourceRef[];
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: FallbackReason;
  /** The provider that was tried first when a fallback happened. */
  readonly attemptedProvider?: string;
  readonly correlationId: string;
  readonly cached: boolean;
};

export type ExplanationResponse = {
  readonly explanation: Explanation;
  readonly meta: ExplanationMeta;
  /** The facts the explanation was grounded in (authoritative system facts, shown separately from the prose). */
  readonly facts: readonly Fact[];
};

export type ProviderRequest = {
  readonly context: ExplanationContext;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly signal: AbortSignal;
};

export type ProviderResponse = {
  /** Unvalidated. The service validates every provider's output, including the template's. */
  readonly output: unknown;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
};

/** The port the application depends on. The Gemini adapter is one implementation, never the only one. */
export interface ExplanationProvider {
  readonly name: string;
  readonly model?: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export type ProviderErrorCode =
  "TIMEOUT" | "QUOTA" | "UNAVAILABLE" | "AUTH" | "MALFORMED" | "NOT_CONFIGURED" | "ERROR";

/** A provider failure. The message never contains credentials, prompts or response bodies. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** One governance record per explanation attempt (spec 18.2). No prompt text, no secrets. */
export type ExplanationGovernanceRecord = {
  readonly recordId: string;
  readonly at: string;
  readonly caseId: string;
  readonly audience: Audience;
  readonly actorId: string;
  readonly useCases: readonly string[];
  readonly provider: string;
  readonly model?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly sourceIds: readonly string[];
  readonly factIds: readonly string[];
  readonly validation: "VALID" | "REJECTED" | "NOT_RUN";
  readonly validationCode?: string;
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: FallbackReason;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cached: boolean;
  readonly correlationId: string;
};

export interface ExplanationLog {
  append(record: ExplanationGovernanceRecord): void;
  list(): readonly ExplanationGovernanceRecord[];
}

export class InMemoryExplanationLog implements ExplanationLog {
  private readonly records: ExplanationGovernanceRecord[] = [];
  append(record: ExplanationGovernanceRecord): void {
    this.records.push(record);
  }
  list(): readonly ExplanationGovernanceRecord[] {
    return [...this.records];
  }
}
