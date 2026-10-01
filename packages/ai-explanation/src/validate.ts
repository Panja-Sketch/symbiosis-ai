import { INTERVENTION_LABELS, RESULT_LABELS } from "./phrases";
import { EXPLANATION_SECTIONS } from "./types";
import type { Explanation, ExplanationContext } from "./types";

/**
 * Strict validation of any provider's output against the facts it was given (spec 18.1: invalid
 * schema, unknown evidence or action id and unsupported statements are rejected). Nothing is
 * partially trusted: one failed check rejects the whole explanation and the caller falls back.
 *
 * The checks are deliberately conservative text and set checks, not a language model: they cannot
 * prove a sentence true, but they remove the failure modes that matter here (changing a result or
 * a level, inventing a number, an id or an action, claiming resolution, underwriting or authorship).
 */

export type ValidationCode =
  | "SCHEMA"
  | "EMPTY"
  | "UNKNOWN_SOURCE"
  | "INVENTED_NUMBER"
  | "INVENTED_ID"
  | "UNKNOWN_ACTION"
  | "RESULT_CONTRADICTION"
  | "LEVEL_CONTRADICTION"
  | "PROHIBITED_CLAIM";

export type ValidationResult =
  | { readonly ok: true; readonly value: Explanation }
  | { readonly ok: false; readonly code: ValidationCode; readonly detail: string };

const bad = (code: ValidationCode, detail: string): ValidationResult => ({
  ok: false,
  code,
  detail,
});

const KEYS: readonly string[] = ["summary", ...EXPLANATION_SECTIONS, "sourceFactIds"];
export const LIMITS = { summary: 700, item: 450, items: 10, sourceIds: 40 } as const;

function parseShape(
  raw: unknown,
): { ok: true; value: Explanation } | { ok: false; detail: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: "not an object" };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!KEYS.includes(k)) return { ok: false, detail: `unexpected key ${k}` };
  }
  if (
    typeof o.summary !== "string" ||
    o.summary.trim() === "" ||
    o.summary.length > LIMITS.summary
  ) {
    return { ok: false, detail: "summary" };
  }
  const arrays: Record<string, readonly string[]> = {};
  for (const k of [...EXPLANATION_SECTIONS, "sourceFactIds"] as const) {
    const v = o[k];
    if (!Array.isArray(v)) return { ok: false, detail: `${k} is not an array` };
    const max = k === "sourceFactIds" ? LIMITS.sourceIds : LIMITS.items;
    if (v.length > max) return { ok: false, detail: `${k} is too long` };
    for (const s of v) {
      if (typeof s !== "string" || s.trim() === "" || s.length > LIMITS.item) {
        return { ok: false, detail: `${k} has an invalid item` };
      }
    }
    arrays[k] = v as string[];
  }
  return {
    ok: true,
    value: {
      summary: o.summary.trim(),
      keyFacts: arrays.keyFacts ?? [],
      whyItMatters: arrays.whyItMatters ?? [],
      actionContext: arrays.actionContext ?? [],
      verificationExplanation: arrays.verificationExplanation ?? [],
      interventionExplanation: arrays.interventionExplanation ?? [],
      evidenceExplanation: arrays.evidenceExplanation ?? [],
      limitations: arrays.limitations ?? [],
      sourceFactIds: arrays.sourceFactIds ?? [],
    },
  };
}

const ID_TOKEN = /\b[A-Z]{2,8}(?:-[A-Za-z0-9]+)+\b/g;
const CODE_TOKEN = /\b[A-Z]{3,}(?:_[A-Z0-9]+)+\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;

const PROHIBITED: readonly [RegExp, string][] = [
  [
    /\b(resolved|eliminated|guaranteed|permanently|fixed|solved|cured|risk[- ]free)\b/i,
    "claims the risk is resolved",
  ],
  [
    /\b(premium|pricing|underwrit\w*|coverage|policyholder)\b/i,
    "underwriting, premium or coverage language",
  ],
  [/\b(dispatch\w*|schedul\w*)\b/i, "implies someone is dispatched or scheduled"],
  [
    /non-?repudiation|legally (binding|admissible)|tamper[- ]proof|proves? (who|authorship)|digitally signed by/i,
    "unsupported legal or authorship claim",
  ],
  [
    /\b(I|we) (verified|determined|concluded|decided|closed|changed|updated|approved)\b/i,
    "claims an action the model cannot take",
  ],
  [
    /\b(gemini|the ai|artificial intelligence) (verified|determined|decided|concluded|confirmed)\b/i,
    "gives the AI authority",
  ],
];

const allLabels = (m: Readonly<Record<string, string>>) => Object.entries(m);

export function validateExplanation(raw: unknown, ctx: ExplanationContext): ValidationResult {
  const shaped = parseShape(raw);
  if (!shaped.ok) return bad("SCHEMA", shaped.detail);
  const e = shaped.value;
  const sections = EXPLANATION_SECTIONS.flatMap((k) => e[k]);
  if (e.sourceFactIds.length === 0) return bad("EMPTY", "no source facts cited");

  const factIds = new Set(ctx.facts.map((f) => f.id));
  for (const id of e.sourceFactIds) {
    if (!factIds.has(id)) return bad("UNKNOWN_SOURCE", `unknown fact id ${id}`);
  }

  const text = [e.summary, ...sections].join("\n");
  for (const [re, why] of PROHIBITED) {
    if (re.test(text)) return bad("PROHIBITED_CLAIM", why);
  }

  // ids and codes may only be ones the system itself supplied
  const known = [
    ...ctx.facts.map((f) => f.value),
    ...ctx.facts.map((f) => f.id),
    ...ctx.sources.flatMap((s) => [s.id, s.version ?? ""]),
    ...ctx.allowedActions.flatMap((a) => [a.id, a.title]),
    ctx.caseId,
  ].join("\n");
  const knownIds = new Set([...known.matchAll(ID_TOKEN)].map((m) => m[0]));
  const knownCodes = new Set([...known.matchAll(CODE_TOKEN)].map((m) => m[0]));
  const allowedActionIds = new Set(ctx.allowedActions.map((a) => a.id));
  for (const m of text.matchAll(ID_TOKEN)) {
    if (m[0].startsWith("ACT-") && !allowedActionIds.has(m[0])) {
      return bad(
        "UNKNOWN_ACTION",
        `action ${m[0]} is not in the approved action library for this case`,
      );
    }
    if (!knownIds.has(m[0])) return bad("INVENTED_ID", `identifier ${m[0]} was not supplied`);
  }
  for (const m of text.matchAll(CODE_TOKEN)) {
    if (!knownCodes.has(m[0])) return bad("INVENTED_ID", `code ${m[0]} was not supplied`);
  }

  // every number must be one the facts already contain (no invented measurements)
  const stripIds = (s: string) => s.replace(ID_TOKEN, " ").replace(CODE_TOKEN, " ");
  const knownNumbers = new Set([...stripIds(known).matchAll(NUMBER)].map((m) => Number(m[0])));
  for (const m of stripIds(text).matchAll(NUMBER)) {
    if (!knownNumbers.has(Number(m[0])))
      return bad("INVENTED_NUMBER", `number ${m[0]} is not in the supplied facts`);
  }

  // the verification result may not be restated as another result (summary and result sections only)
  const result = ctx.authoritative.verificationResult;
  if (result !== undefined) {
    const resultText = [e.summary, ...e.verificationExplanation].join("\n").toLowerCase();
    for (const [code, label] of allLabels(RESULT_LABELS)) {
      if (code !== result && resultText.includes(label.toLowerCase())) {
        return bad("RESULT_CONTRADICTION", `restates the result as "${label}"`);
      }
    }
  } else {
    const resultText = [e.summary, ...e.verificationExplanation].join("\n").toLowerCase();
    const factText = ctx.facts
      .map((f) => f.value)
      .join("\n")
      .toLowerCase();
    for (const [, label] of allLabels(RESULT_LABELS)) {
      if (resultText.includes(label.toLowerCase()) && !factText.includes(label.toLowerCase())) {
        return bad(
          "RESULT_CONTRADICTION",
          `mentions "${label}" but no verification result was supplied`,
        );
      }
    }
  }

  // the intervention level may not be restated as another level (intervention section and summary)
  const level = ctx.authoritative.interventionLevel;
  const levelText = [e.summary, ...e.interventionExplanation].join("\n").toLowerCase();
  for (const [code, label] of allLabels(INTERVENTION_LABELS)) {
    if (code !== level && levelText.includes(label.toLowerCase())) {
      return bad("LEVEL_CONTRADICTION", `names the level "${label}"`);
    }
  }
  return { ok: true, value: e };
}
