import { INTERVENTION_MEANING, RESULT_MEANING } from "./phrases";
import type {
  Explanation,
  ExplanationContext,
  ExplanationProvider,
  ProviderRequest,
  ProviderResponse,
} from "./types";

const cap = (s: string): string => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1));
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * The deterministic explanation: a plain-language rendering of the established facts using static
 * wording, written for each audience. It needs no network, is byte-for-byte reproducible, and is the
 * fallback for every failure of any other provider. Its output goes through the same validator as a
 * model's, so it can never say more than the facts do.
 */
export function templateExplanation(ctx: ExplanationContext): Explanation {
  const byId = new Map(ctx.facts.map((f) => [f.id, f.value]));
  const used = new Set<string>();
  const get = (id: string): string | undefined => {
    const v = byId.get(id);
    if (v !== undefined) used.add(id);
    return v;
  };
  const facility = ctx.audience === "FACILITY";
  const result = ctx.authoritative.verificationResult;
  const level = ctx.authoritative.interventionLevel;

  // ---- summary -------------------------------------------------------------------------------------
  const caseFact = get(facility ? "F-CASE" : "F-RISK") ?? get("F-CASE");
  const parts: string[] = [];
  parts.push(
    facility
      ? `Based on the verified records available to Symbiosis, this is a ${caseFact ?? "case"}.`
      : `Based on the evidence the customer shared, this is ${caseFact === undefined ? "a shared case" : `a ${caseFact}`}.`,
  );
  const state = get("F-STATE");
  if (state !== undefined) parts.push(stop(cap(state)));
  const verification = get("F-VERIFICATION");
  if (verification !== undefined) {
    parts.push(`The deterministic verification engine recorded: ${verification}.`);
  } else {
    parts.push(
      facility
        ? "There is no completed verification result yet, so improvement has not been confirmed."
        : "No verification result is available in what was shared, so improvement cannot be confirmed from it.",
    );
  }
  const recurrence = get("F-RECURRENCE");
  if (recurrence !== undefined) parts.push(`Recurrence: ${recurrence}.`);

  // ---- sections ------------------------------------------------------------------------------------
  const keyFacts: string[] = [];
  for (const id of ["F-DETECTION", "F-ACCOUNTABILITY"]) {
    const v = get(id);
    if (v !== undefined) keyFacts.push(stop(cap(v)));
  }
  for (const f of ctx.facts.filter((x) => x.id.startsWith("F-ACTION-"))) {
    get(f.id);
    keyFacts.push(stop(cap(f.value)));
  }
  if (recurrence !== undefined) keyFacts.push(stop(cap(recurrence)));

  const whyItMatters: string[] = [
    facility
      ? "A persistent abnormal pattern is a risk signal for people to act on; it is not a prediction of loss."
      : "The evidence shows whether a customer-reported action was followed by a sensor-verified improvement, which is different from the action simply being reported.",
  ];
  if (level !== undefined && facility) {
    whyItMatters.push(
      `The current risk-engineer recommendation is ${get("F-INTERVENTION") ?? level}.`,
    );
  }

  const actionContext: string[] = [];
  const actionFacts = ctx.facts.filter((f) => f.id.startsWith("F-ACTION-"));
  if (actionFacts.length === 0) {
    actionContext.push(
      facility && ctx.allowedActions.length > 0
        ? `No action has been reported yet. Approved options in the action library: ${ctx.allowedActions.map((a) => a.title).join("; ")}. A person carries out and reports any action.`
        : "No action report is available.",
    );
  } else {
    for (const f of actionFacts) actionContext.push(stop(cap(f.value)));
    actionContext.push(
      "A reported action shows what a person said was done; it does not by itself show the risk went down.",
    );
  }

  const verificationExplanation: string[] = [];
  if (verification !== undefined && result !== undefined) {
    verificationExplanation.push(
      `The deterministic verification engine concluded that ${RESULT_MEANING[result] ?? "the outcome is as recorded"}.`,
    );
    for (const f of ctx.facts.filter((x) => x.id.startsWith("F-CRITERION-"))) {
      get(f.id);
      verificationExplanation.push(stop(cap(f.value)));
    }
    const q = get("F-QUALITY");
    if (q !== undefined) verificationExplanation.push(`Data quality: ${q}.`);
    const p = get("F-POLICY");
    if (p !== undefined) verificationExplanation.push(`Policy used: ${p}.`);
  } else {
    verificationExplanation.push(
      "A verification explanation is not available because no completed result is in the supplied facts.",
    );
  }

  const interventionExplanation: string[] = [];
  const iv = get("F-INTERVENTION");
  if (iv !== undefined && level !== undefined) {
    interventionExplanation.push(stop(cap(iv)));
    interventionExplanation.push(
      `This level is produced by a versioned deterministic policy, not by an AI model. In practice it means: ${INTERVENTION_MEANING[level] ?? "as recorded"}.`,
    );
  }

  const evidenceExplanation: string[] = [];
  const ev = get("F-EVIDENCE");
  if (ev !== undefined) {
    evidenceExplanation.push(stop(cap(ev)));
    evidenceExplanation.push(
      "The package records what the sensors showed and what was reported when the verification was made. It lets a reader check that its content has not changed since then.",
    );
    evidenceExplanation.push(
      "It does not show who produced it, it is not a signed document, and it does not prove anything beyond the recorded readings and reports.",
    );
  }
  const sharing = get("F-SHARING");
  if (sharing !== undefined)
    evidenceExplanation.push(
      `Sharing: ${sharing}. Sharing evidence does not share raw sensor readings.`,
    );

  const limitations: string[] = ctx.unavailable.map((u) => stop(cap(u)));
  limitations.push(
    "This explanation restates recorded system facts. It does not verify, decide or change anything.",
  );

  return {
    summary: parts.join(" "),
    keyFacts,
    whyItMatters,
    actionContext,
    verificationExplanation,
    interventionExplanation,
    evidenceExplanation,
    limitations,
    sourceFactIds: [...used],
  };
}

export class TemplateExplanationProvider implements ExplanationProvider {
  readonly name = "template";
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    return { output: templateExplanation(request.context) };
  }
}
