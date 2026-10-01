import { formatTime } from "../lib/format";
import { TIMELINE } from "../lib/labels";

/**
 * The case timeline, built only from the case's audit history. An audit action without an entry in
 * the milestone table is internal bookkeeping and is not shown; nothing is invented.
 */
export function Timeline({
  entries,
}: {
  readonly entries: readonly {
    readonly auditId: string;
    readonly action: string;
    readonly at: string;
  }[];
}) {
  const shown = entries.flatMap((e) => {
    const m = TIMELINE[e.action];
    return m === undefined ? [] : [{ ...e, ...m }];
  });
  if (shown.length === 0) {
    return <p className="muted">No milestones recorded yet.</p>;
  }
  return (
    <ol className="timeline" aria-label="Case timeline">
      {shown.map((e) => (
        <li key={e.auditId} className={`timeline-item kind-${e.kind}`} data-action={e.action}>
          <span className="timeline-dot" aria-hidden="true" />
          <div>
            <strong>{e.label}</strong>
            <time dateTime={e.at}>{formatTime(e.at)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
