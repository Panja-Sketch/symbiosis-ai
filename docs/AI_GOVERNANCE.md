# AI Governance (S8)

PROJECT_SPEC.md Part VII (sections 18 and 18.1 to 18.2) is the source of truth; this file records how S8
implements it. **AI advises; deterministic code decides state; humans act; sensors verify.**

## What Gemini may and may not do

Gemini (Vertex AI) only **explains facts the deterministic system already established**: the case, the
verification result, recurrence, the risk-engineer recommendation and the evidence package. It cannot
detect risk, set severity, create or change a case or risk event, decide or alter a verification, decide
recurrence, choose or run an action, choose an intervention level, decide consent, alter evidence,
price, underwrite or control hardware. The explanation path has **no write access**: it reads through the
same authorized read paths as the screens and writes only a governance log entry and an in-process cache.

## Architecture

- **Port:** `ExplanationProvider { name, model?, generate(request) }` in `packages/ai-explanation`. The
  application depends on the port; `ExplanationService` orchestrates it.
- **Providers:** `TemplateExplanationProvider` (deterministic, offline, the fallback and the default) and
  `GeminiExplanationProvider` (Vertex AI `generateContent` over REST; no SDK; credential supplied by a
  token function; the only file that knows the endpoint or sends a credential). `FakeGemini` is a scripted
  Vertex endpoint so tests, browser tests and smokes run the real adapter without a network.
- **Facts:** `buildFacilityContext` (from the facility `CaseView` plus evidence metadata) and
  `buildInsurerContext` (from the consent-filtered insurer projection only). Each fact has a stable id
  (`F-VERIFICATION`, `F-CRITERION-VIBRATION`...). A section the audience cannot see is absent and is listed
  as "not shared", never filled in. Inputs have no field for telemetry streams, device keys, credentials or
  other tenants, so none can reach a prompt. Only derived metrics (before/after means, completeness,
  confidence, criterion outcomes, recurrence, recommendation) are sent.
- **Routes:** `GET /api/v1/cases/:id/explanation` (same authorization and tenant scoping as the case) and
  `GET /insurance/v1/cases/:id/explanation` (consent gateway on every request, audited as an insurer read).
  Responses carry `explanation`, `meta` (provider, model, prompt/schema version, source ids, fallback
  flags, correlation id) and the `facts` used. Prompts are never returned.

## Output schema (`explanation-output.v1`)

`summary` plus arrays `keyFacts`, `whyItMatters`, `actionContext`, `verificationExplanation`,
`interventionExplanation`, `evidenceExplanation`, `limitations` and `sourceFactIds`. Unknown keys are
rejected (so `newCaseState` or `verificationResult` can never be smuggled in), lengths are capped, and every
`sourceFactIds` entry must be a supplied fact.

## Grounding and validation

The system prompt is a fixed constant (rules: use only the facts, copy numbers and ids, never restate a
status, a report is not proof, no resolution/premium/coverage/legal claims, no new actions, third-person
wording). Every provider output, including the template's, is validated; **one failed check rejects the
whole explanation**: schema; unknown fact id; any number not present in the facts; any identifier or code
not supplied; an `ACT-` id outside the case's approved action library; restating the verification result or
the recommendation level as another; claims of resolution, premium/underwriting/coverage language,
dispatch or scheduling, non-repudiation/legal/authorship claims, or the AI claiming authority. The checks
are conservative text and set checks: they remove the failure modes that matter, they do not prove prose true.

## Prompt injection

Operator notes are the only free text. They never enter facts or the system prompt; they are length-limited
(500 chars), stripped of control characters, JSON-encoded and placed in a separate
`UNTRUSTED_TEXT_BEGIN ... END` block declared to be data, with delimiter look-alikes neutralized. Even a
model that obeys an injected instruction is caught by validation (and cannot change state in any case);
the template ignores notes entirely. Insurer inputs contain no notes.

## Failure behavior

Timeout (default 8 s), quota, outage, auth failure, malformed JSON, schema or validation failure, a thrown
error or a hung provider all fall back to the template. The request still returns 200, nothing else
changes, and the reason is recorded. A failing governance log cannot break an explanation. No AI failure can
block detection, workflow, verification, recurrence, evidence or sharing: none of them calls this package.

## Governance record (spec 18.2)

One `ExplanationGovernanceRecord` per request: case, audience, actor, use cases, provider, model, prompt and
schema version, source and fact ids, validation outcome and code, fallback flag and reason, latency,
token counts, cached flag, correlation id. No prompt text, no credentials.

## Caching

In-process, keyed by audience, case, provider, model, prompt version and a hash of the exact facts,
authoritative values, sources and unavailable list; fallback answers live 60 s, AI answers 10 min. Callers
always rebuild the facts through the authorized read path first, so an explanation can never outlive the
facts or the consent that produced them (an insurer is denied after revocation even if text is cached).

## UI labelling

Case detail (facility) and shared case (insurer) show an "Authoritative system facts (deterministic)" box,
taken from the API's own fact list, above a separate dashed "AI explanation" box. Only a Gemini answer that
passed validation is labelled "AI-generated explanation based on verified system data"; the template is
labelled "Template summary ... No AI model was used", and a fallback says why the AI was not used. The
explanation streams in after the deterministic page (React Suspense) and never replaces a status.

## Configuration and secrets

`config/explanation/explanation.v1.json` (versioned): default provider `template`, model
`gemini-2.5-flash` (the spec names no model; this is the configured default, not a silent choice, and is
overridable with `GEMINI_MODEL`), region, temperature 0.1, token cap, timeout, cache lifetimes.
Environment: `SYMBIOSIS_AI_PROVIDER` (`template`|`gemini`), `GEMINI_MODEL`, `GCP_PROJECT_ID`, `GCP_REGION`,
`VERTEX_ACCESS_TOKEN` (placeholder names only in `.env.example`; nothing is committed). `gemini` without a
project or token degrades to the template. Workload identity and Secret Manager replace the token in S9.
