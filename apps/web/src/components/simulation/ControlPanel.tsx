"use client";

import { fieldValue, fieldChecked } from "../../lib/dom";
import { useEffect, useMemo, useState } from "react";
import { problemText, simPost } from "../../lib/sim-client";
import type {
  NumericField,
  PhysicalValues,
  SensorCondition,
  SensorGroupId,
  SensorHealth,
  SimOverview,
} from "../../lib/sim-types";

/**
 * Controls for the simulated PHYSICAL world: temperatures, vibration, current, load, equipment
 * on or off, and the condition of each sensor gateway. Bounds come from the server and are checked
 * here only to give instant feedback; the server validates every change again. There is no control
 * for a risk, a case, a severity or a verification result, because none exists: the platform
 * decides what these numbers mean.
 */
export type ControlSpec =
  | { readonly kind: "number"; readonly field: NumericField; readonly hint?: string }
  | {
      readonly kind: "toggle";
      readonly field: "primaryRunning" | "backupRunning";
      readonly label: string;
    }
  | { readonly kind: "sensor"; readonly group: SensorGroupId };

export const WORLD_SPECS: readonly ControlSpec[] = [
  { kind: "number", field: "zoneTemperatureC" },
  { kind: "number", field: "relativeHumidityPct" },
  {
    kind: "number",
    field: "vibrationRmsMs2",
    hint: "Normal is about 0.30; the primary unit degrades above that.",
  },
  { kind: "number", field: "currentA", hint: "Normal is about 12 A at 80% load." },
  { kind: "number", field: "loadPercent" },
  { kind: "toggle", field: "primaryRunning", label: "Primary cooling unit (CU-A) running" },
  { kind: "toggle", field: "backupRunning", label: "Backup cooling unit (CU-B) running" },
  {
    kind: "number",
    field: "outdoorTemperatureC",
    hint: "Used only when the weather mode is Simulated.",
  },
  { kind: "sensor", group: "hvac" },
  { kind: "sensor", group: "vibration" },
  { kind: "sensor", group: "meter" },
];

type Draft = {
  numbers: Partial<Record<NumericField, string>>;
  toggles: Partial<Record<"primaryRunning" | "backupRunning", boolean>>;
  sensors: Partial<
    Record<SensorGroupId, Partial<{ health: SensorHealth; stale: string; dropout: boolean }>>
  >;
};

const empty = (): Draft => ({ numbers: {}, toggles: {}, sensors: {} });

function numberError(
  raw: string | undefined,
  b: { min: number; max: number; unit: string; label: string },
): string | null {
  if (raw === undefined) return null;
  if (raw.trim() === "") return `${b.label} needs a number.`;
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${b.label} must be a number.`;
  if (n < b.min || n > b.max) return `${b.label} must be between ${b.min} and ${b.max} ${b.unit}.`;
  return null;
}

export function ControlForm({
  overview,
  specs,
  title,
  idPrefix,
  disabled,
  onApplied,
}: {
  readonly overview: SimOverview;
  readonly specs: readonly ControlSpec[];
  readonly title: string;
  readonly idPrefix: string;
  readonly disabled: boolean;
  readonly onApplied: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(empty());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const v = overview.values;
  const bounds = overview.bounds;

  // A different set of controls (a different sensor was selected) starts from a clean draft.
  const specKey = specs.map((s) => (s.kind === "sensor" ? `s:${s.group}` : s.field)).join(",");
  useEffect(() => {
    setDraft(empty());
    setMessage(null);
  }, [specKey]);

  const errors = useMemo(() => {
    const out: string[] = [];
    for (const s of specs) {
      if (s.kind === "number") {
        const e = numberError(draft.numbers[s.field], bounds.numeric[s.field]);
        if (e !== null) out.push(e);
      }
      if (s.kind === "sensor") {
        const raw = draft.sensors[s.group]?.stale;
        if (raw !== undefined) {
          const n = Number(raw);
          if (raw.trim() === "" || !Number.isInteger(n) || n < 0 || n > bounds.staleSecondsMax) {
            out.push(
              `${bounds.sensorGroups[s.group]}: staleness must be a whole number from 0 to ${bounds.staleSecondsMax} seconds.`,
            );
          }
        }
      }
    }
    return out;
  }, [draft, specs, bounds]);

  const patch = useMemo(() => {
    const p: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(draft.numbers)) {
      if (raw !== undefined && Number(raw) !== v[k as NumericField]) p[k] = Number(raw);
    }
    for (const [k, val] of Object.entries(draft.toggles)) {
      if (val !== undefined && val !== v[k as "primaryRunning" | "backupRunning"]) p[k] = val;
    }
    const sensors: Record<string, Partial<SensorCondition>> = {};
    for (const [g, d] of Object.entries(draft.sensors)) {
      const cur = v.sensors[g as SensorGroupId];
      const c: { health?: SensorHealth; staleSeconds?: number; dropout?: boolean } = {};
      if (d?.health !== undefined && d.health !== cur.health) c.health = d.health;
      if (d?.stale !== undefined && Number(d.stale) !== cur.staleSeconds)
        c.staleSeconds = Number(d.stale);
      if (d?.dropout !== undefined && d.dropout !== cur.dropout) c.dropout = d.dropout;
      if (Object.keys(c).length > 0) sensors[g] = c;
    }
    if (Object.keys(sensors).length > 0) p.sensors = sensors;
    return p;
  }, [draft, v]);

  const dirty = Object.keys(patch).length > 0;

  async function apply() {
    setBusy(true);
    setMessage(null);
    const r = await simPost<unknown>("simulation/state", {
      patch,
      expectedRevision: overview.session.revision,
    });
    setBusy(false);
    if (r.ok) {
      setDraft(empty());
      setMessage({
        kind: "ok",
        text: "Applied. The simulated world changed; watch the sensors respond.",
      });
      onApplied();
    } else {
      setMessage({ kind: "error", text: problemText(r.problem) });
      if (r.problem.code === "REVISION_CONFLICT") onApplied();
    }
  }

  const numberValue = (f: NumericField) => draft.numbers[f] ?? String(v[f]);

  return (
    <form
      className="control-form"
      aria-label={title}
      data-testid={`${idPrefix}-form`}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && errors.length === 0 && !disabled) void apply();
      }}
    >
      <h3>{title}</h3>
      {specs.map((s) => {
        if (s.kind === "number") {
          const b = bounds.numeric[s.field];
          const id = `${idPrefix}-${s.field}`;
          const err = numberError(draft.numbers[s.field], b);
          return (
            <div className="control-row" key={s.field}>
              <label htmlFor={id}>
                {b.label} <span className="muted">({b.unit})</span>
              </label>
              <div className="control-inputs">
                <input
                  type="range"
                  aria-label={`${b.label} slider`}
                  min={b.min}
                  max={b.max}
                  step={b.step}
                  value={
                    Number.isFinite(Number(numberValue(s.field)))
                      ? Number(numberValue(s.field))
                      : v[s.field]
                  }
                  disabled={disabled}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, numbers: { ...d.numbers, [s.field]: fieldValue(e) } }))
                  }
                />
                <input
                  id={id}
                  data-testid={id}
                  type="number"
                  inputMode="decimal"
                  min={b.min}
                  max={b.max}
                  step={b.step}
                  value={numberValue(s.field)}
                  disabled={disabled}
                  aria-invalid={err !== null}
                  aria-describedby={`${id}-help`}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, numbers: { ...d.numbers, [s.field]: fieldValue(e) } }))
                  }
                />
              </div>
              <p
                id={`${id}-help`}
                className={err === null ? "muted control-help" : "control-help control-error"}
              >
                {err ??
                  `Allowed ${b.min} to ${b.max} ${b.unit}.${s.hint !== undefined ? ` ${s.hint}` : ""}`}
              </p>
            </div>
          );
        }
        if (s.kind === "toggle") {
          const id = `${idPrefix}-${s.field}`;
          const checked = draft.toggles[s.field] ?? v[s.field];
          return (
            <div className="control-row control-row-inline" key={s.field}>
              <input
                id={id}
                data-testid={id}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, toggles: { ...d.toggles, [s.field]: fieldChecked(e) } }))
                }
              />
              <label htmlFor={id}>{s.label}</label>
            </div>
          );
        }
        const g = s.group;
        const cur = v.sensors[g];
        const d = draft.sensors[g] ?? {};
        const id = `${idPrefix}-sensor-${g}`;
        return (
          <fieldset className="control-sensor" key={g} disabled={disabled}>
            <legend>{bounds.sensorGroups[g]}</legend>
            <div className="control-row">
              <label htmlFor={`${id}-health`}>Reported health</label>
              <select
                id={`${id}-health`}
                data-testid={`${id}-health`}
                value={d.health ?? cur.health}
                onChange={(e) =>
                  setDraft((x) => ({
                    ...x,
                    sensors: { ...x.sensors, [g]: { ...d, health: fieldValue(e) as SensorHealth } },
                  }))
                }
              >
                <option value="HEALTHY">Healthy</option>
                <option value="DEGRADED">Degraded</option>
                <option value="FAULT">Fault</option>
              </select>
            </div>
            <div className="control-row">
              <label htmlFor={`${id}-stale`}>Readings are this old (seconds)</label>
              <input
                id={`${id}-stale`}
                data-testid={`${id}-stale`}
                type="number"
                min={0}
                max={bounds.staleSecondsMax}
                step={1}
                value={d.stale ?? String(cur.staleSeconds)}
                onChange={(e) =>
                  setDraft((x) => ({
                    ...x,
                    sensors: { ...x.sensors, [g]: { ...d, stale: fieldValue(e) } },
                  }))
                }
              />
              <p className="muted control-help">
                Whole seconds, 0 (fresh) to {bounds.staleSecondsMax}.
              </p>
            </div>
            <div className="control-row control-row-inline">
              <input
                id={`${id}-dropout`}
                data-testid={`${id}-dropout`}
                type="checkbox"
                checked={d.dropout ?? cur.dropout}
                onChange={(e) =>
                  setDraft((x) => ({
                    ...x,
                    sensors: { ...x.sensors, [g]: { ...d, dropout: fieldChecked(e) } },
                  }))
                }
              />
              <label htmlFor={`${id}-dropout`}>Send no readings at all (missing data)</label>
            </div>
          </fieldset>
        );
      })}
      <div className="control-actions">
        <button
          type="submit"
          className="btn"
          data-testid={`${idPrefix}-apply`}
          disabled={disabled || busy || !dirty || errors.length > 0}
        >
          {busy ? "Applying…" : "Apply to the simulated world"}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={!dirty || busy}
          onClick={() => setDraft(empty())}
        >
          Discard
        </button>
        {disabled && <span className="muted">Your role cannot change the simulated world.</span>}
      </div>
      {errors.length > 0 && (
        <ul className="control-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {message !== null && (
        <p
          className={message.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={message.kind === "ok" ? "status" : "alert"}
          data-testid={`${idPrefix}-message`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}

export type { PhysicalValues };
