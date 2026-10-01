import type { ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { formatTime } from "../lib/format";
import type { ExplanationDto } from "../lib/types";

/**
 * The plain-language explanation, visually separate from the authoritative facts. It never states
 * or replaces a status: the system facts box shows what the deterministic engines recorded (taken
 * from the API's own fact list), and the prose below it is labelled for what it is: AI-generated
 * only when a Gemini model produced it and it passed validation; otherwise a fixed template.
 */

const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  TIMEOUT: "the AI service did not answer in time",
  QUOTA: "the AI service quota was reached",
  UNAVAILABLE: "the AI service is unavailable",
  AUTH: "the AI service could not be authenticated",
  MALFORMED_OUTPUT: "the AI answer was not in the expected format",
  VALIDATION_FAILED: "the AI answer did not match the verified facts, so it was discarded",
  NOT_CONFIGURED: "the AI service is not configured",
  PROVIDER_ERROR: "the AI service reported an error",
  DISABLED: "AI explanations are switched off",
};

const AUTHORITATIVE_IDS = ["F-STATE", "F-VERIFICATION", "F-INTERVENTION", "F-RECURRENCE"] as const;

export function ExplanationLoading() {
  return (
    <div className="loading" role="status" aria-live="polite" data-testid="explanation-loading">
      <span className="spinner" aria-hidden="true" />
      <span>
        Preparing the plain-language summary. The system facts on this page are already final.
      </span>
    </div>
  );
}

function List({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="plain-list">
        {items.map((t, i) => (
          <li key={`${i}-${t.slice(0, 24)}`}>{t}</li>
        ))}
      </ul>
    </>
  );
}

export function ExplanationPanel({
  result,
  audience,
}: {
  readonly result: { readonly ok: true; readonly value: ExplanationDto } | ApiError;
  readonly audience: "FACILITY" | "INSURER";
}): ReactNode {
  const heading = (
    <h2 id="explanation-h">
      <span className="section-number section-ai" aria-hidden="true">
        ✦
      </span>
      Plain-language summary
    </h2>
  );
  if (!result.ok) {
    return (
      <section
        className="section section-wide explanation"
        id="explanation"
        aria-labelledby="explanation-h"
        data-explanation="unavailable"
      >
        {heading}
        <p className="muted" role="status">
          The plain-language summary is not available right now
          {result.status === 403 || result.status === 404 ? " for this identity or case" : ""}.
          Nothing else on this page depends on it, and the system facts above are unchanged.
        </p>
      </section>
    );
  }
  const { explanation: e, meta, facts } = result.value;
  const ai = meta.provider === "gemini" && !meta.fallbackUsed;
  const fallbackWhy =
    meta.fallbackReason !== undefined ? FALLBACK_TEXT[meta.fallbackReason] : undefined;
  const authoritative = AUTHORITATIVE_IDS.flatMap((id) => {
    const f = facts.find((x) => x.id === id);
    return f === undefined ? [] : [f];
  });
  const status = ai ? "ai" : meta.fallbackUsed ? "fallback" : "template";
  return (
    <section
      className="section section-wide explanation"
      id="explanation"
      aria-labelledby="explanation-h"
      data-explanation={status}
      data-provider={meta.provider}
    >
      {heading}
      <p className="section-question">
        {audience === "FACILITY"
          ? "What does this mean, in plain words?"
          : "What does this evidence mean, based only on what the customer shared?"}
      </p>

      <div className="fact-box" data-testid="authoritative-facts">
        <p className="fact-box-title">Authoritative system facts (deterministic)</p>
        {authoritative.length === 0 ? (
          <p className="muted">No verification or recommendation facts are recorded yet.</p>
        ) : (
          <dl className="kv">
            {authoritative.map((f) => (
              <div key={f.id}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className={`ai-box ai-${status}`} data-testid="explanation-text">
        {ai ? (
          <p className="ai-label">
            <span className="badge tone-synthetic">
              <span className="badge-icon" aria-hidden="true">
                ✦
              </span>
              <span>AI explanation</span>
            </span>{" "}
            AI-generated explanation based on verified system data. It restates the facts above and
            cannot change them.
          </p>
        ) : (
          <p className="ai-label">
            <span className="badge tone-neutral">
              <span className="badge-icon" aria-hidden="true">
                ≡
              </span>
              <span>Template summary</span>
            </span>{" "}
            {meta.fallbackUsed
              ? `The AI explanation was not used because ${fallbackWhy ?? "it was unavailable"}. This summary was written from the same system facts by a fixed template; no AI model was used.`
              : "Written from the system facts above by a fixed template. No AI model was used."}
          </p>
        )}
        <p className="explanation-summary">{e.summary}</p>
        <List title="Key facts" items={e.keyFacts} />
        <List title="Why it matters" items={e.whyItMatters} />
        <List title="About the action" items={e.actionContext} />
        <List title="About the verification" items={e.verificationExplanation} />
        <List title="About the recommendation" items={e.interventionExplanation} />
        <List title="About the evidence" items={e.evidenceExplanation} />
        <List title="Limits of this explanation" items={e.limitations} />
      </div>

      <p className="muted" data-testid="explanation-meta">
        Generated {formatTime(meta.generatedAt)} by{" "}
        {ai ? `${meta.provider} (${meta.model ?? "model"})` : "template"} · prompt{" "}
        {meta.promptVersion} · based on {e.sourceFactIds.length} system facts
        {meta.cached ? " · cached" : ""}.
      </p>
      <details className="history">
        <summary>System facts this summary is based on ({facts.length})</summary>
        <ul className="plain-list">
          {facts.map((f) => (
            <li key={f.id}>
              <code>{f.id}</code> {f.label}: {f.value}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
