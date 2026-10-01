import { formatValue } from "../lib/format";
import { criterionLabel, outcomeLabel, verificationReason } from "../lib/labels";
import type { CriterionStatDto } from "../lib/types";
import { ToneBadge } from "./ui";

/** One measured criterion, normalised from the facility or the insurer projection. */
export type CompareItem = {
  readonly criterionId: string;
  readonly role?: string;
  readonly outcome?: string;
  readonly signal?: string;
  readonly metric?: string;
  readonly before?: CriterionStatDto;
  readonly after?: CriterionStatDto;
  readonly reasonCodes?: readonly string[];
};

const range = (s: CriterionStatDto): string =>
  s.min !== undefined && s.max !== undefined
    ? `range ${formatValue(s.min)} to ${formatValue(s.max)} · ${s.sampleCount} readings`
    : `${s.sampleCount} readings`;

const OUTCOME_TONE = (o: string | undefined) =>
  o === "PASS" ? ("good" as const) : o === "FAIL" ? ("danger" as const) : ("warn" as const);
const OUTCOME_ICON = (o: string | undefined) => (o === "PASS" ? "✓" : o === "FAIL" ? "✕" : "◐");

function Bars({ item }: { readonly item: CompareItem }) {
  const b = item.before?.mean;
  const a = item.after?.mean;
  // Bars start at zero and share one scale, so the picture never exaggerates a difference.
  const top = Math.max(b ?? 0, a ?? 0) || 1;
  const pct = (v: number | undefined) => `${Math.max(2, Math.round(((v ?? 0) / top) * 100))}%`;
  return (
    <div className="compare-bars">
      <div className="compare-row">
        <span className="compare-name">Before mitigation</span>
        <div className="compare-track">
          <div className="compare-bar compare-before" style={{ width: pct(b) }} />
        </div>
        <span className="compare-value">
          <strong>{formatValue(b)}</strong>
          {item.before !== undefined && <span className="muted">{range(item.before)}</span>}
        </span>
      </div>
      <div className="compare-row">
        <span className="compare-name">After mitigation</span>
        <div className="compare-track">
          <div className="compare-bar compare-after" style={{ width: pct(a) }} />
        </div>
        <span className="compare-value">
          <strong>{formatValue(a)}</strong>
          {item.after !== undefined && <span className="muted">{range(item.after)}</span>}
        </span>
      </div>
    </div>
  );
}

/**
 * Before / after for the physical criteria, from backend values only. Criteria that have a before
 * and an after value are drawn as two bars on one zero-based scale; the others (temperature trend,
 * backup capacity, data quality, device integrity) are listed with their outcome and reasons.
 * Nothing is computed here beyond bar width.
 */
export function BeforeAfter({ items }: { readonly items: readonly CompareItem[] }) {
  const measured = items.filter((i) => i.before?.mean !== undefined && i.after?.mean !== undefined);
  const checks = items.filter((i) => !measured.includes(i));
  if (items.length === 0) return null;
  return (
    <div className="compare" data-testid="before-after">
      {measured.map((i) => (
        <figure className="compare-item" key={`${i.criterionId}-${i.signal ?? ""}`}>
          <figcaption>
            <strong>{criterionLabel(i.criterionId)}</strong>
            {i.outcome !== undefined && (
              <ToneBadge tone={OUTCOME_TONE(i.outcome)} icon={OUTCOME_ICON(i.outcome)}>
                {outcomeLabel(i.outcome)}
              </ToneBadge>
            )}
          </figcaption>
          <Bars item={i} />
          {(i.reasonCodes ?? []).length > 0 && (
            <p className="muted">{(i.reasonCodes ?? []).map(verificationReason).join(" · ")}</p>
          )}
        </figure>
      ))}
      {checks.length > 0 && (
        <ul className="check-list">
          {checks.map((i) => (
            <li key={i.criterionId}>
              <span>
                <strong>{criterionLabel(i.criterionId)}</strong>
                {i.role === "SUPPORTING" && <span className="muted"> · supporting</span>}
                {i.metric === "slope_deg_c_per_hour" && i.after?.mean !== undefined && (
                  <span className="muted">
                    {" "}
                    · trend after action {formatValue(i.after.mean)} °C per hour
                  </span>
                )}
                {(i.reasonCodes ?? []).length > 0 && (
                  <span className="muted">
                    {" "}
                    · {(i.reasonCodes ?? []).map(verificationReason).join(" · ")}
                  </span>
                )}
              </span>
              {i.outcome !== undefined && (
                <ToneBadge tone={OUTCOME_TONE(i.outcome)} icon={OUTCOME_ICON(i.outcome)}>
                  {outcomeLabel(i.outcome)}
                </ToneBadge>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted compare-note">
        Values are the mean of the readings recorded in each window, in the units the device
        reports. Bars start at zero and share a scale. Raw readings are not shown.
      </p>
    </div>
  );
}
