import { FLOW_STAGES } from "../lib/labels";
import type { FlowStage } from "../lib/labels";

const COPY: Readonly<Record<FlowStage, string>> = {
  DETECT: "A deterministic rule spots a persistent risk",
  UNDERSTAND: "See what happened and why it matters",
  ACT: "A person carries out an approved action",
  VERIFY: "Sensors check the readings after the action",
  PROVE: "An evidence package records the outcome",
  MONITOR: "The case is watched for recurrence",
};

/** DETECT → UNDERSTAND → ACT → VERIFY → PROVE → MONITOR, with the case's current stage marked. */
export function FlowStrip({
  current,
  compact,
}: {
  readonly current?: FlowStage;
  readonly compact?: boolean;
}) {
  const at = current === undefined ? -1 : FLOW_STAGES.indexOf(current);
  return (
    <ol className={`flow${compact === true ? " flow-compact" : ""}`} aria-label="Symbiosis flow">
      {FLOW_STAGES.map((s, i) => (
        <li
          key={s}
          className={i < at ? "flow-done" : i === at ? "flow-current" : "flow-todo"}
          {...(i === at ? { "aria-current": "step" as const } : {})}
        >
          <span className="flow-name">{s}</span>
          {compact !== true && <span className="flow-copy">{COPY[s]}</span>}
          {i < at && <span className="visually-hidden"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}
