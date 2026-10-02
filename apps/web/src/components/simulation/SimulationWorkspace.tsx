"use client";

import { fieldValue } from "../../lib/dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { WEATHER_STATUS, formatClock } from "../../lib/sim-format";
import { problemText, simGet, simPost } from "../../lib/sim-client";
import type { PulseResult, SimOverview, SimSeries, TimelineItem } from "../../lib/sim-types";
import type { CaseDto } from "../../lib/types";
import { CaseWorkflow, EvidencePanel, VerificationPanel } from "./CasePanels";
import { ControlForm, WORLD_SPECS } from "./ControlPanel";
import { FacilityTwin } from "./FacilityTwin";
import { IntegrationLab } from "./IntegrationLab";
import {
  NotificationsPanel,
  Pill,
  RulePanel,
  ScenarioBar,
  SensorDetail,
  TimelinePanel,
  WeatherCard,
} from "./Panels";
import { PolicyPanel } from "./PolicyPanel";

/**
 * The Facility Simulation workspace. It shows backend read models and forwards intent. It refreshes
 * the overview every few seconds and, while a simulation is running, asks the server for the next
 * 5-second samples of the simulated world (the server signs and sends them like any gateway would).
 * Nothing here decides a risk, a state or an outcome.
 */
const POLL_MS = 2500;
const PULSE_MS = 5000;
const TIMELINE_MS = 5000;
const SERIES_MS = 10000;

function Section({
  id,
  title,
  question,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly question?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="sim-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {question !== undefined && <p className="section-question">{question}</p>}
      {children}
    </section>
  );
}

export function SimulationWorkspace({
  initial,
  actorId,
}: {
  readonly initial: SimOverview;
  readonly actorId: string;
}) {
  const [overview, setOverview] = useState<SimOverview>(initial);
  const [caseDto, setCaseDto] = useState<CaseDto | undefined>();
  const [timeline, setTimeline] = useState<readonly TimelineItem[]>([]);
  const [series, setSeries] = useState<SimSeries | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(initial.session.generation);
  const caseIdRef = useRef<string | null>(initial.activeCaseId);

  const refreshOverview = useCallback(async () => {
    const r = await simGet<SimOverview>("simulation");
    if (!r.ok) {
      setOffline(
        r.problem.status === 0
          ? "The connection to the server was lost. Retrying…"
          : problemText(r.problem),
      );
      return;
    }
    setOffline(null);
    generationRef.current = r.value.session.generation;
    caseIdRef.current = r.value.activeCaseId;
    setOverview(r.value);
    const id = r.value.activeCaseId;
    if (id === null) setCaseDto(undefined);
    else {
      const c = await simGet<CaseDto>(`cases/${encodeURIComponent(id)}`);
      if (c.ok) setCaseDto(c.value);
    }
  }, []);

  const refreshTimeline = useCallback(async () => {
    const r = await simGet<{ items: readonly TimelineItem[] }>("simulation/timeline?limit=120");
    if (r.ok) setTimeline(r.value.items);
  }, []);
  const refreshSeries = useCallback(async () => {
    const r = await simGet<SimSeries>("simulation/series?seconds=900");
    if (r.ok) setSeries(r.value);
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshOverview(), refreshTimeline(), refreshSeries()]);
  }, [refreshOverview, refreshTimeline, refreshSeries]);

  useEffect(() => {
    void refreshAll();
    const a = setInterval(() => void refreshOverview(), POLL_MS);
    const b = setInterval(() => void refreshTimeline(), TIMELINE_MS);
    const c = setInterval(() => void refreshSeries(), SERIES_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, [refreshAll, refreshOverview, refreshTimeline, refreshSeries]);

  // The pulse: while RUNNING, send the next samples of the simulated world.
  const running = overview.session.status === "RUNNING";
  const canControl = overview.permissions.control;
  useEffect(() => {
    if (!running || !canControl) return;
    let stopped = false;
    const pulse = async () => {
      const r = await simPost<PulseResult>("simulation/pulse", {
        generation: generationRef.current,
      });
      if (stopped) return;
      if (!r.ok && r.problem.code === "SESSION_RESET") {
        setBanner({
          kind: "error",
          text: "The simulation was reset elsewhere. This page reloaded its state.",
        });
        void refreshAll();
      }
    };
    void pulse();
    const t = setInterval(() => void pulse(), PULSE_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [running, canControl, refreshAll]);

  const selectedSensor = overview.sensors.find((s) => s.sensorId === selected);
  const weather = overview.weather;
  const wst = WEATHER_STATUS[weather.status];

  async function session(action: "start" | "stop") {
    setBusy(true);
    setBanner(null);
    const r = await simPost<unknown>(`simulation/session/${action}`, {});
    setBusy(false);
    if (!r.ok) setBanner({ kind: "error", text: problemText(r.problem) });
    await refreshAll();
  }
  async function setWeatherMode(mode: "LIVE" | "SIMULATED") {
    setBusy(true);
    const r = await simPost<unknown>("simulation/weather", { mode });
    setBusy(false);
    if (!r.ok) setBanner({ kind: "error", text: problemText(r.problem) });
    await refreshOverview();
  }
  async function reset() {
    setBusy(true);
    setBanner(null);
    const r = await simPost<unknown>("simulation/reset", { confirm });
    setBusy(false);
    if (r.ok) {
      setResetting(false);
      setConfirm("");
      setCaseDto(undefined);
      setBanner({
        kind: "ok",
        text: "The simulation was reset to a clean, known-normal state. Start it to begin learning what normal looks like.",
      });
    } else setBanner({ kind: "error", text: problemText(r.problem) });
    await refreshAll();
  }

  const live = overview.liveness;
  return (
    <div className="sim" data-testid="sim-workspace" data-session-status={overview.session.status}>
      <div className="sim-topbar" role="region" aria-label="Simulation status">
        <div className="sim-topbar-main">
          <strong data-testid="sim-facility">{overview.facility.name}</strong>
          <span className="muted"> · {overview.facility.location.label}</span>
        </div>
        <div className="sim-topbar-chips">
          <Pill tone="synthetic" icon="◇" testId="sim-data-badge">
            Simulation data
          </Pill>
          <Pill
            tone={running ? (live === "LIVE" ? "good" : "warn") : "neutral"}
            icon={running ? (live === "LIVE" ? "●" : "❚❚") : "■"}
            testId="sim-status"
          >
            {running
              ? live === "LIVE"
                ? "Running · live"
                : "Running · paused (this page is not sending)"
              : "Stopped"}
          </Pill>
          <Pill tone="info" icon="⏱" testId="sim-clock">
            Real time {formatClock(overview.clock.nowIso)}
          </Pill>
          <Pill tone={wst.tone} icon={wst.icon} testId="sim-weather-chip">
            {wst.label}
            {weather.reading !== undefined
              ? ` · ${((weather.reading.temperatureC * 9) / 5 + 32).toFixed(0)}°F`
              : ""}
          </Pill>
          <Pill tone="synthetic" icon="◇">
            {overview.policy.label} {overview.policy.activeLabel}
          </Pill>
        </div>
        <div className="sim-topbar-actions">
          {overview.permissions.control && (
            <>
              {!running ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="sim-start"
                  disabled={busy}
                  onClick={() => void session("start")}
                >
                  Start simulation
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-quiet"
                  data-testid="sim-stop"
                  disabled={busy}
                  onClick={() => void session("stop")}
                >
                  Stop
                </button>
              )}
            </>
          )}
          {overview.permissions.reset && (
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="sim-reset-open"
              disabled={busy}
              onClick={() => setResetting((x) => !x)}
              aria-expanded={resetting}
            >
              Reset simulation
            </button>
          )}
        </div>
      </div>
      {resetting && (
        <form
          className="notice notice-warn sim-reset"
          data-testid="sim-reset-form"
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <p>
            <strong>Reset the simulation?</strong> This removes only this simulation facility's
            cases, readings, baselines and evidence records, and starts a clean generation. The
            audit log, policy versions and adapter versions are kept. Nothing else is touched.
          </p>
          <label htmlFor="reset-confirm">Type RESET to confirm</label>{" "}
          <input
            id="reset-confirm"
            data-testid="sim-reset-confirm"
            value={confirm}
            onChange={(e) => setConfirm(fieldValue(e))}
            autoComplete="off"
          />{" "}
          <button
            type="submit"
            className="btn"
            data-testid="sim-reset-go"
            disabled={busy || confirm !== "RESET"}
          >
            Reset now
          </button>{" "}
          <button type="button" className="btn btn-quiet" onClick={() => setResetting(false)}>
            Cancel
          </button>
        </form>
      )}
      {offline !== null && (
        <p className="notice notice-error" role="alert" data-testid="sim-offline">
          {offline}
        </p>
      )}
      {banner !== null && (
        <p
          className={banner.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={banner.kind === "ok" ? "status" : "alert"}
          data-testid="sim-banner"
        >
          {banner.text}
        </p>
      )}
      <p className="muted sim-clock-note">{overview.clock.label}</p>
      <nav className="sim-jump" aria-label="Jump to a section">
        <ul>
          {[
            ["sim-facility-view", "Facility"],
            ["sim-controls", "Scenarios and controls"],
            ["sim-rule", "Risk rule"],
            ["sim-case", "Case and action"],
            ["sim-verification", "Verification"],
            ["sim-evidence", "Evidence and sharing"],
            ["sim-timeline", "Timeline"],
            ["sim-integration", "Integration"],
            ["sim-policy", "Demo policy"],
          ].map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <Section
        id="sim-facility-view"
        title="Facility, equipment and sensors"
        question="What is being monitored, and what does each sensor say right now?"
      >
        <div className="sim-grid-main">
          <FacilityTwin overview={overview} selectedId={selected} onSelect={setSelected} />
          <div className="sim-side">
            <SensorDetail
              overview={overview}
              sensor={selectedSensor}
              onApplied={() => void refreshAll()}
            />
            <WeatherCard overview={overview} />
          </div>
        </div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
          <table className="table table-stack" data-testid="sensor-table">
            <caption className="visually-hidden">All sensors and their latest readings</caption>
            <thead>
              <tr>
                <th scope="col">Sensor</th>
                <th scope="col">Reading</th>
                <th scope="col">State</th>
                <th scope="col">Last update</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {overview.sensors.map((s) => (
                <tr key={s.sensorId}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setSelected(s.sensorId)}
                    >
                      {s.name}
                    </button>
                    <span className="muted block">{s.assetName}</span>
                  </th>
                  <td data-label="Reading">
                    {s.value === null
                      ? "no data"
                      : typeof s.value === "boolean"
                        ? s.value
                          ? "Running"
                          : "Stopped"
                        : `${Number(s.value.toFixed(3))} ${s.unit}`}
                  </td>
                  <td data-label="State">{s.status.replace(/_/g, " ").toLowerCase()}</td>
                  <td data-label="Last update">
                    {s.ageSeconds === null ? "—" : `${s.ageSeconds} s ago`}
                  </td>
                  <td data-label="Source">{s.sourceLabel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        id="sim-controls"
        title="Scenarios and manual controls"
        question="Change the simulated world. The platform decides what it means."
      >
        <ScenarioBar overview={overview} onApplied={() => void refreshAll()} />
        <div className="control-form" data-testid="weather-mode">
          <h3>Weather source</h3>
          <div role="radiogroup" aria-label="Weather source" className="radio-row">
            <label>
              <input
                type="radio"
                name="weather-mode"
                data-testid="weather-mode-live"
                checked={overview.session.weatherMode === "LIVE"}
                disabled={!canControl || busy}
                onChange={() => void setWeatherMode("LIVE")}
              />{" "}
              Live weather (the real outdoor conditions from the weather provider)
            </label>
            <label>
              <input
                type="radio"
                name="weather-mode"
                data-testid="weather-mode-simulated"
                checked={overview.session.weatherMode === "SIMULATED"}
                disabled={!canControl || busy}
                onChange={() => void setWeatherMode("SIMULATED")}
              />{" "}
              Simulated weather (the outdoor temperature below; labelled SIMULATED, never live)
            </label>
          </div>
        </div>
        <ControlForm
          overview={overview}
          specs={WORLD_SPECS}
          title="Manual controls: the simulated physical world"
          idPrefix="world"
          disabled={!canControl}
          onApplied={() => void refreshAll()}
        />
      </Section>

      <Section
        id="sim-rule"
        title="Risk rule evaluation"
        question="Which conditions combine, and how far has the pattern persisted?"
      >
        <RulePanel overview={overview} />
      </Section>

      <Section
        id="sim-case"
        title="Case, alert and human action"
        question="Who was told, who acknowledged, what was done, and did anything actually improve?"
      >
        <CaseWorkflow
          overview={overview}
          caseDto={caseDto}
          actorId={actorId}
          onChanged={() => void refreshAll()}
        />
        <h3>Notifications</h3>
        <NotificationsPanel overview={overview} onChecked={() => void refreshAll()} />
      </Section>

      <Section
        id="sim-verification"
        title="Verification: reported complete is not verified improved"
        question="What do the sensors say after the action?"
      >
        <VerificationPanel caseDto={caseDto} series={series} />
      </Section>

      <Section
        id="sim-evidence"
        title="Evidence and customer-controlled sharing"
        question="What was recorded, and what can the insurer see?"
      >
        <EvidencePanel overview={overview} caseDto={caseDto} onChanged={() => void refreshAll()} />
      </Section>

      <Section
        id="sim-timeline"
        title="Live event timeline"
        question="What happened, in order? Every line is a backend record."
      >
        <TimelinePanel items={timeline} />
      </Section>

      <Section
        id="sim-integration"
        title="Integration / Adapter view"
        question="How do different systems reach one canonical contract?"
      >
        <IntegrationLab overview={overview} />
      </Section>

      <Section
        id="sim-policy"
        title="Demo policy"
        question="Which thresholds apply to this simulation, and who changed them?"
      >
        <PolicyPanel overview={overview} />
      </Section>
    </div>
  );
}
