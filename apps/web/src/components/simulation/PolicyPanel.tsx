"use client";

import { fieldValue } from "../../lib/dom";
import { useCallback, useEffect, useState } from "react";
import { formatClock } from "../../lib/sim-format";
import { problemText, simGet, simPost } from "../../lib/sim-client";
import type { PolicyParam, PolicyView, SimOverview } from "../../lib/sim-types";
import { Pill } from "./Panels";

/**
 * The DEMO / SIMULATION POLICY editor (D-092). It edits a bounded set of numbers; every change creates
 * a NEW immutable version with who, when and why, and cases keep the version they were judged under.
 * It cannot touch the production or insurer policy: those files are not reachable from here.
 */
export function PolicyPanel({ overview }: { readonly overview: SimOverview }) {
  const [view, setView] = useState<PolicyView | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = overview.permissions.editPolicy;

  const load = useCallback(async () => {
    const r = await simGet<PolicyView>("simulation/policy");
    if (r.ok) setView(r.value);
  }, []);
  useEffect(() => {
    void load();
  }, [load, overview.policy.activeVersion]);

  if (view === undefined) return <p className="muted">Loading the policy…</p>;

  const errorFor = (p: PolicyParam, raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return `${p.label} needs a number.`;
    if (n < p.min || n > p.max)
      return `${p.label} must be between ${p.min} and ${p.max} ${p.unit}.`;
    if (p.integer && !Number.isInteger(n)) return `${p.label} must be a whole number.`;
    return null;
  };
  const values = (): Record<string, number> => {
    const out: Record<string, number> = { ...view.active.values };
    for (const [k, raw] of Object.entries(draft)) out[k] = Number(raw);
    return out;
  };
  const changed = Object.entries(draft).filter(([k, raw]) => Number(raw) !== view.active.values[k]);
  const errors = view.parameters
    .map((p) => errorFor(p, draft[p.id]))
    .filter((e): e is string => e !== null);
  const groups = [...new Set(view.parameters.map((p) => p.group))];

  async function save() {
    setBusy(true);
    setMessage(null);
    const r = await simPost<{ version: number }>("simulation/policy", { values: values(), reason });
    setBusy(false);
    if (r.ok) {
      setDraft({});
      setReason("");
      setMessage({
        kind: "ok",
        text: `Published demo policy sim.${r.value.version}. It applies to the next evaluation.`,
      });
      await load();
    } else setMessage({ kind: "error", text: problemText(r.problem) });
  }
  async function activate(version: number) {
    setBusy(true);
    setMessage(null);
    const r = await simPost<unknown>("simulation/policy/activate", {
      version,
      reason: "Rolled back from the workspace",
    });
    setBusy(false);
    setMessage(
      r.ok
        ? { kind: "ok", text: `Demo policy sim.${version} is active again.` }
        : { kind: "error", text: problemText(r.problem) },
    );
    if (r.ok) await load();
  }

  return (
    <div data-testid="policy-panel">
      <div className="rule-head">
        <Pill tone="synthetic" icon="◇" testId="policy-label">
          {view.label}
        </Pill>
        <Pill tone="info" testId="policy-active">
          Active version {view.active.label}
        </Pill>
      </div>
      <p className="muted">{view.note}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canEdit && changed.length > 0 && errors.length === 0) void save();
        }}
      >
        {groups.map((g) => (
          <div key={g}>
            <h3>{g}</h3>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
              <table className="table policy-table">
                <caption className="visually-hidden">{g} settings</caption>
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Operator</th>
                    <th scope="col">Value</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Role</th>
                    <th scope="col">Allowed</th>
                  </tr>
                </thead>
                <tbody>
                  {view.parameters
                    .filter((p) => p.group === g)
                    .map((p) => {
                      const err = errorFor(p, draft[p.id]);
                      return (
                        <tr key={p.id}>
                          <th scope="row">
                            <label htmlFor={`pol-${p.id}`}>{p.label}</label>
                            <span className="muted block">{p.description}</span>
                          </th>
                          <td>{p.operator}</td>
                          <td>
                            <input
                              id={`pol-${p.id}`}
                              data-testid={`pol-${p.id}`}
                              type="number"
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              value={draft[p.id] ?? String(view.active.values[p.id])}
                              disabled={!canEdit}
                              aria-invalid={err !== null}
                              aria-describedby={`pol-${p.id}-help`}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.id]: fieldValue(e) }))}
                            />
                            {err !== null && (
                              <span
                                id={`pol-${p.id}-help`}
                                className="control-error block"
                                role="alert"
                              >
                                {err}
                              </span>
                            )}
                          </td>
                          <td>{p.unit}</td>
                          <td>{p.role}</td>
                          <td>
                            {p.min} to {p.max}
                            <span className="muted block">default {p.default}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {canEdit ? (
          <div className="control-form">
            <div className="control-row">
              <label htmlFor="pol-reason">Why are you changing it? (recorded with your name)</label>
              <input
                id="pol-reason"
                data-testid="pol-reason"
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(fieldValue(e))}
              />
            </div>
            <div className="control-actions">
              <button
                type="submit"
                className="btn"
                data-testid="pol-save"
                disabled={
                  busy || changed.length === 0 || errors.length > 0 || reason.trim().length < 3
                }
              >
                Publish as a new version
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={changed.length === 0 || busy}
                onClick={() => setDraft({})}
              >
                Discard
              </button>
              <span className="muted">
                {changed.length} change{changed.length === 1 ? "" : "s"} pending
              </span>
            </div>
          </div>
        ) : (
          <p className="muted">Your role can read this policy but not change it.</p>
        )}
      </form>
      {message !== null && (
        <p
          className={message.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={message.kind === "ok" ? "status" : "alert"}
          data-testid="policy-message"
        >
          {message.text}
        </p>
      )}
      <h3>Versions (history is never overwritten)</h3>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
        <table className="table" data-testid="policy-versions">
          <caption className="visually-hidden">Policy versions</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Who</th>
              <th scope="col">When</th>
              <th scope="col">Why</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.versions.map((v) => (
              <tr key={v.version}>
                <th scope="row">
                  {v.label}
                  {v.version === view.active.version && (
                    <span className="badge tone-good"> active</span>
                  )}
                </th>
                <td>{v.createdBy}</td>
                <td>{v.builtin ? "built in" : formatClock(v.createdAt)}</td>
                <td>{v.reason}</td>
                <td>
                  {v.version !== view.active.version && canEdit && (
                    <button
                      type="button"
                      className="btn btn-small btn-quiet"
                      disabled={busy}
                      onClick={() => void activate(v.version)}
                    >
                      Make active
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
