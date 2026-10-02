"use client";

import { fieldValue } from "../../lib/dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatClock } from "../../lib/sim-format";
import { problemText, simGet, simPost } from "../../lib/sim-client";
import type {
  AdapterCompare,
  AdapterPreview,
  AdapterProfile,
  AdapterTraceDto,
  FieldTrace,
  SimOverview,
} from "../../lib/sim-types";
import { Pill } from "./Panels";

/**
 * Integration / Adapter view: how different (synthetic) vendors reach one canonical contract.
 * Source payload -> versioned adapter mapping -> canonical observation -> validation -> real ingestion.
 * A preview is a DRY RUN (nothing is ingested). The mapping is declarative data, never code; invalid
 * mappings and incompatible units are refused, and this screen shows exactly why.
 */
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function unsupportedExample(profileId: string, sample: unknown): unknown {
  const s = JSON.parse(JSON.stringify(sample ?? {})) as Record<string, unknown>;
  if (profileId === "sim-vibration-gateway") return { ...s, rms: { value: 4.7, unit: "mm/s" } };
  if (profileId === "sim-electrical-meter") return { ...s, contactor: "UNKNOWN" };
  if (profileId === "sim-hvac-controller")
    return {
      ...s,
      zone: { temp: { value: 40, unit: "rankine" }, rh: { value: 0.5, unit: "fraction" } },
    };
  return { ...s, run_state: "MAYBE", vib_rms: -3 };
}

const valueText = (f: FieldTrace) =>
  f.status === "ACCEPTED"
    ? `${typeof f.canonicalValue === "number" ? Number(f.canonicalValue.toFixed(4)) : String(f.canonicalValue)} ${f.canonicalUnit === "boolean" ? "" : f.canonicalUnit}`
    : "rejected";

export function IntegrationLab({ overview }: { readonly overview: SimOverview }) {
  const [profiles, setProfiles] = useState<readonly AdapterProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [payload, setPayload] = useState("");
  const [preview, setPreview] = useState<AdapterPreview | undefined>();
  const [compare, setCompare] = useState<AdapterCompare | undefined>();
  const [definition, setDefinition] = useState("");
  const [issues, setIssues] = useState<readonly string[] | undefined>();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await simGet<{ profiles: readonly AdapterProfile[] }>("simulation/adapters");
    if (r.ok) {
      setProfiles(r.value.profiles);
      setProfileId((cur) => (cur === "" ? (r.value.profiles[0]?.profileId ?? "") : cur));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, [load]);

  const profile = useMemo(
    () => profiles.find((p) => p.profileId === profileId),
    [profiles, profileId],
  );
  // Reset the editors when another profile (or a new active version) is shown.
  const key = `${profileId}@${profile?.activeVersion ?? 0}`;
  useEffect(() => {
    if (profile === undefined) return;
    setPayload(pretty(profile.samplePayload));
    setDefinition(pretty(profile.definition ?? {}));
    setPreview(undefined);
    setIssues(undefined);
    setMessage(null);
  }, [key]);

  async function runPreview(text: string) {
    setBusy(true);
    setMessage(null);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      setBusy(false);
      setMessage({ kind: "error", text: "That is not valid JSON, so it cannot be evaluated." });
      return;
    }
    const r = await simPost<AdapterPreview>("simulation/adapters/preview", {
      profileId,
      payload: body,
    });
    setBusy(false);
    if (r.ok) setPreview(r.value);
    else setMessage({ kind: "error", text: problemText(r.problem) });
  }
  async function validate() {
    setBusy(true);
    let def: unknown;
    try {
      def = JSON.parse(definition);
    } catch {
      setBusy(false);
      setIssues(["The mapping is not valid JSON."]);
      return;
    }
    const r = await simPost<{ valid: boolean; issues: readonly string[] }>(
      "simulation/adapters/validate",
      { definition: def },
    );
    setBusy(false);
    setIssues(r.ok ? (r.value.valid ? [] : r.value.issues) : [problemText(r.problem)]);
  }
  async function publish() {
    setBusy(true);
    setMessage(null);
    let def: unknown;
    try {
      def = JSON.parse(definition);
    } catch {
      setBusy(false);
      setIssues(["The mapping is not valid JSON."]);
      return;
    }
    const r = await simPost<{ version: number }>("simulation/adapters/publish", {
      definition: def,
      reason,
    });
    setBusy(false);
    if (r.ok) {
      setMessage({
        kind: "ok",
        text: `Published version ${r.value.version}. New payloads use it; earlier ones stay explainable under theirs.`,
      });
      setReason("");
      await load();
    } else {
      setIssues(r.problem.issues ?? [problemText(r.problem)]);
      setMessage({ kind: "error", text: "The mapping was refused; nothing changed." });
    }
  }
  async function activateVersion(version: number) {
    setBusy(true);
    const r = await simPost<unknown>("simulation/adapters/activate", { profileId, version });
    setBusy(false);
    setMessage(
      r.ok
        ? { kind: "ok", text: `Version ${version} is active again.` }
        : { kind: "error", text: problemText(r.problem) },
    );
    if (r.ok) await load();
  }
  async function runCompare() {
    setBusy(true);
    const r = await simGet<AdapterCompare>("simulation/adapters/compare");
    setBusy(false);
    if (r.ok) setCompare(r.value);
    else setMessage({ kind: "error", text: problemText(r.problem) });
  }

  if (profiles.length === 0) return <p className="muted">Loading the adapter profiles…</p>;
  const traces: readonly AdapterTraceDto[] = profile?.recentTraces ?? [];
  const lastIngested = traces[0];
  return (
    <div data-testid="integration-lab">
      <p className="muted">
        Symbiosis does not need proprietary sensors. Each system below is a{" "}
        <strong>synthetic</strong> vendor profile, not a real integration. Each sends its own
        payload shape; a versioned, declarative adapter turns it into the same canonical
        observation, and everything after that is identical.
      </p>
      <div role="tablist" aria-label="Source profiles" className="tabs">
        {profiles.map((p) => (
          <button
            key={p.profileId}
            role="tab"
            type="button"
            aria-selected={p.profileId === profileId}
            data-testid={`profile-${p.profileId}`}
            className={p.profileId === profileId ? "tab tab-on" : "tab"}
            onClick={() => setProfileId(p.profileId)}
          >
            {p.displayName}
            <span className="muted block">v{p.activeVersion}</span>
          </button>
        ))}
      </div>
      {profile !== undefined && (
        <>
          <p>
            <strong>{profile.displayName}</strong> · {profile.vendorLabel}{" "}
            <Pill tone="synthetic" icon="◇">
              Synthetic profile
            </Pill>
          </p>
          <p className="muted">{profile.description}</p>
          <p className="muted">
            Live devices using it:{" "}
            {profile.boundDevices.length === 0
              ? "none (shown through dry-run previews and the comparison below)"
              : profile.boundDevices.map((d) => d.displayName).join(", ")}
          </p>
          <div className="flow" data-testid="adapter-flow">
            <section className="flow-col" aria-labelledby="flow-1">
              <h3 id="flow-1">1. Source payload</h3>
              <label htmlFor="lab-payload" className="visually-hidden">
                Source payload (JSON)
              </label>
              <textarea
                id="lab-payload"
                data-testid="lab-payload"
                rows={14}
                spellCheck={false}
                value={payload}
                onChange={(e) => setPayload(fieldValue(e))}
              />
              <div className="control-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="lab-preview"
                  disabled={busy}
                  onClick={() => void runPreview(payload)}
                >
                  Run through the adapter (dry run)
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  disabled={busy}
                  onClick={() => setPayload(pretty(profile.samplePayload))}
                >
                  Current simulated world
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  data-testid="lab-unsupported"
                  disabled={busy}
                  onClick={() =>
                    setPayload(pretty(unsupportedExample(profile.profileId, profile.samplePayload)))
                  }
                >
                  Try an unsupported value
                </button>
              </div>
            </section>
            <section className="flow-col" aria-labelledby="flow-2">
              <h3 id="flow-2">2. Adapter mapping (v{profile.activeVersion})</h3>
              <ul className="mapping" data-testid="mapping-list">
                {profile.mapping.map((m) => (
                  <li key={m.signal}>
                    <code>{m.sourcePath}</code> → <strong>{m.signal}</strong> ({m.canonicalUnit})
                    {m.units.length > 0 && (
                      <ul className="muted">
                        {m.units.map((u) => (
                          <li key={u.unit}>
                            source unit <code>{u.unit}</code>: {u.conversion}
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.enum !== undefined && (
                      <span className="muted block">
                        text states:{" "}
                        {Object.entries(m.enum)
                          .map(([k, v]) => `${k}=${v ? "on" : "off"}`)
                          .join(", ")}
                      </span>
                    )}
                    {m.bounds !== undefined && (
                      <span className="muted block">
                        accepted range {m.bounds.min} to {m.bounds.max}
                      </span>
                    )}
                    <span className="muted block">
                      asset:{" "}
                      {m.asset.fixed ??
                        (m.asset.path !== undefined
                          ? `from ${m.asset.path} via ${Object.entries(m.asset.map ?? {})
                              .map(([k, v]) => `${k}→${v}`)
                              .join(", ")}`
                          : "")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="flow-col" aria-labelledby="flow-3">
              <h3 id="flow-3">3. Canonical observation</h3>
              {preview === undefined ? (
                <p className="muted">
                  Run the payload through the adapter to see the canonical result.
                </p>
              ) : preview.observations.length === 0 ? (
                <p className="muted" data-testid="lab-no-observations">
                  Nothing was accepted, so nothing would be ingested.
                </p>
              ) : (
                <ul className="mapping" data-testid="lab-observations">
                  {preview.observations.map((o) => (
                    <li key={`${o.assetId}-${o.signal}`}>
                      <strong>{o.signal}</strong> ={" "}
                      {typeof o.value === "number" ? Number(o.value.toFixed(4)) : String(o.value)}{" "}
                      {o.unit === "boolean" ? "" : o.unit}
                      <span className="muted block">asset {o.assetId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flow-col" aria-labelledby="flow-4">
              <h3 id="flow-4">4. Validation</h3>
              {preview === undefined ? (
                <p className="muted">
                  Each field is checked for presence, type, unit, range and permitted asset.
                </p>
              ) : (
                <>
                  <p>
                    <Pill
                      tone={
                        preview.trace.outcome === "ACCEPTED"
                          ? "good"
                          : preview.trace.outcome === "PARTIAL"
                            ? "warn"
                            : "danger"
                      }
                      icon={preview.trace.outcome === "ACCEPTED" ? "✓" : "✕"}
                      testId="lab-outcome"
                    >
                      {preview.trace.outcome} · {preview.trace.accepted} accepted,{" "}
                      {preview.trace.rejected} rejected
                    </Pill>{" "}
                    <Pill tone="info">DRY RUN</Pill>
                  </p>
                  <ul className="mapping" data-testid="lab-fields">
                    {preview.trace.fields.map((f, i) => (
                      <li
                        key={`${f.sourcePath}-${i}`}
                        data-status={f.status}
                        data-reason={f.reason ?? ""}
                      >
                        <Pill
                          tone={f.status === "ACCEPTED" ? "good" : "danger"}
                          icon={f.status === "ACCEPTED" ? "✓" : "✕"}
                        >
                          {f.status === "ACCEPTED" ? "Accepted" : (f.reason ?? "Rejected")}
                        </Pill>{" "}
                        <code>{f.sourcePath}</code> = {String(f.sourceValue)} {f.sourceUnit ?? ""}
                        <span className="muted block">
                          {f.status === "ACCEPTED"
                            ? `→ ${valueText(f)} (${f.conversion})`
                            : (f.detail ?? "")}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {preview.trace.issues.length > 0 && (
                    <p className="muted">{preview.trace.issues.join("; ")}</p>
                  )}
                </>
              )}
              <p className="muted">
                Trust (freshness, plausible range, authentication, device health) is assigned when a
                payload is really ingested.
              </p>
            </section>
            <section className="flow-col" aria-labelledby="flow-5">
              <h3 id="flow-5">5. Ingested (real pipeline)</h3>
              <p>
                <Pill tone="synthetic" icon="◇">
                  Simulation data
                </Pill>
              </p>
              <dl className="facts">
                <dt>Source type</dt>
                <dd>{profile.synthetic ? "SIMULATOR" : "—"}</dd>
                <dt>Adapter</dt>
                <dd>
                  <code>
                    {profile.profileId}@v{profile.activeVersion}
                  </code>
                </dd>
                <dt>Recent real payloads</dt>
                <dd data-testid="lab-ingested-count">{traces.length}</dd>
              </dl>
              {lastIngested === undefined ? (
                <p className="muted">
                  None yet: this profile has no live device in the running simulation.
                </p>
              ) : (
                <p className="muted" data-testid="lab-last-ingested">
                  Last: {formatClock(lastIngested.receivedAt)} · {lastIngested.outcome} ·{" "}
                  {lastIngested.accepted} accepted, {lastIngested.rejected} rejected.
                </p>
              )}
            </section>
          </div>
        </>
      )}
      <h3>Same physical reading, different vendors, one canonical result</h3>
      <div className="control-actions">
        <button
          type="button"
          className="btn btn-small"
          data-testid="lab-compare"
          disabled={busy}
          onClick={() => void runCompare()}
        >
          Compare the flat gateway with the separate vibration and meter gateways
        </button>
      </div>
      {compare !== undefined && (
        <div data-testid="compare-result">
          <p>
            <Pill
              tone={compare.equivalent ? "good" : "danger"}
              icon={compare.equivalent ? "✓" : "✕"}
              testId="compare-equivalent"
            >
              {compare.equivalent
                ? "Identical canonical observations"
                : "The canonical observations differ"}
            </Pill>{" "}
            <span className="muted">at {formatClock(compare.instantAt)}</span>
          </p>
          <ul className="mapping">
            {compare.compared.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overview.permissions.editAdapters && profile !== undefined && (
        <div className="control-form" data-testid="adapter-editor">
          <h3>Edit this mapping (publishes a new version)</h3>
          <p className="muted">
            A mapping is data validated against a closed schema: no expressions, scripts or code.
            Unknown keys, unknown or incompatible units and duplicate signals are refused.
          </p>
          <label htmlFor="lab-definition" className="visually-hidden">
            Mapping definition (JSON)
          </label>
          <textarea
            id="lab-definition"
            data-testid="lab-definition"
            rows={12}
            spellCheck={false}
            value={definition}
            onChange={(e) => setDefinition(fieldValue(e))}
          />
          <div className="control-row">
            <label htmlFor="lab-reason">Why? (recorded with your name)</label>
            <input
              id="lab-reason"
              data-testid="lab-reason"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(fieldValue(e))}
            />
          </div>
          <div className="control-actions">
            <button
              type="button"
              className="btn btn-small btn-quiet"
              data-testid="lab-validate"
              disabled={busy}
              onClick={() => void validate()}
            >
              Validate
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="lab-publish"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void publish()}
            >
              Publish new version
            </button>
          </div>
          {issues !== undefined &&
            (issues.length === 0 ? (
              <p className="notice notice-ok" role="status" data-testid="lab-valid">
                The mapping is valid.
              </p>
            ) : (
              <ul className="control-errors" role="alert" data-testid="lab-issues">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ))}
          <h4>Versions</h4>
          <ul className="mapping" data-testid="adapter-versions">
            {profile.versions.map((v) => (
              <li key={v.version}>
                v{v.version} ·{" "}
                {v.builtin ? "built in" : `${v.publishedBy}, ${formatClock(v.publishedAt)}`} ·{" "}
                {v.reason}
                {v.version !== profile.activeVersion && (
                  <button
                    type="button"
                    className="btn btn-small btn-quiet"
                    disabled={busy}
                    onClick={() => void activateVersion(v.version)}
                  >
                    Make active
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {message !== null && (
        <p
          className={message.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={message.kind === "ok" ? "status" : "alert"}
          data-testid="lab-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
