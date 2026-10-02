import type { EvaluationOutcome, ObservationEvaluation } from "@symbiosis/contracts";
import type { EventBus, Unsubscribe } from "@symbiosis/event-bus";
import type { TenantDocumentStore } from "@symbiosis/repositories";

/**
 * Rule-evaluation read model (S10, D-091). The detector already concludes, per observation and per
 * sample instant, what it saw (outcome, reason codes, metrics, persistence). This consumer only
 * COPIES those conclusions into a small queryable store so a screen can show "what the rule saw"
 * without re-implementing the rule anywhere. It reads one event type and writes nothing but its own
 * documents; it cannot change a detection, a case or a state.
 */
export type StoredEvaluation = {
  readonly organizationId: string;
  readonly facilityId: string;
  readonly evaluation: ObservationEvaluation;
  readonly recordedFromEvent: string;
};

export type InstantRecord = {
  readonly at: string;
  readonly outcome: EvaluationOutcome;
  readonly qualifying: number;
  readonly required: number;
  readonly reasonCodes: readonly string[];
};

/** The latest conclusion per asset and signal, plus a short history of sample-instant outcomes. */
export type EvaluationHistory = {
  readonly facilityId: string;
  readonly instants: readonly InstantRecord[];
};

export const EVALUATION_HISTORY_ID = "HISTORY";
const MAX_INSTANTS = 60;

export function startEvaluationRecorder(deps: {
  readonly bus: EventBus;
  readonly store: TenantDocumentStore;
}): Unsubscribe {
  return deps.bus.subscribe("risk.observation_evaluated.v1", async (event) => {
    const org = event.organization_id;
    const fac = event.facility_id;
    const e = event.payload;
    const id = `${e.assetId}.${e.signal}`;
    // Keep only the newest observation per asset and signal (events can arrive out of order).
    await deps.store.update<StoredEvaluation>("ruleEvaluations", org, id, (cur) =>
      cur !== undefined && Date.parse(cur.evaluation.observedAt) > Date.parse(e.observedAt)
        ? undefined
        : {
            doc: { organizationId: org, facilityId: fac, evaluation: e, recordedFromEvent: event.event_id },
            index: { facilityId: fac, kind: "LATEST" },
          },
    );
    // One history record per sample instant (the instant-level outcome is repeated on every
    // observation of that instant, so a redelivery or a sibling observation changes nothing).
    if (e.persistence !== undefined || e.instantOutcome !== undefined) {
      await deps.store.update<EvaluationHistory>("ruleEvaluations", org, `${EVALUATION_HISTORY_ID}.${fac}`, (cur) => {
        const instants = cur?.instants ?? [];
        const at = new Date(e.observedAt).toISOString();
        const existing = instants.find((i) => i.at === at);
        // Signals of one sample can arrive in separate events (several gateways): the first event
        // may only see part of the sample. The complete conclusion replaces a partial one, and a
        // conclusion is otherwise never rewritten.
        if (existing !== undefined && existing.outcome !== "INSUFFICIENT_DATA") return undefined;
        if (existing !== undefined && e.instantOutcome === "INSUFFICIENT_DATA") return undefined;
        const next: InstantRecord = {
          at,
          outcome: e.instantOutcome,
          qualifying: e.persistence?.qualifyingEvaluations ?? 0,
          required: e.persistence?.required ?? 0,
          reasonCodes: e.reasonCodes,
        };
        return {
          doc: {
            facilityId: fac,
            instants: [...instants.filter((i) => i.at !== at), next].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_INSTANTS),
          },
          index: { facilityId: fac, kind: "HISTORY" },
        };
      });
    }
  });
}
