"use client";

import type { KeyboardEvent } from "react";
import { SENSOR_STATUS, formatSensorValue } from "../../lib/sim-format";
import type { SimOverview, SimSensor } from "../../lib/sim-types";

/**
 * The facility as a clean diagram: the cold-storage zone, the cooling plant with its primary and
 * backup units, the electrical panel, the site weather, and a node for every sensor. Each node is
 * a real button (keyboard and screen reader): it says its value, its state in words and its place.
 * Everything shown is data from the backend; the diagram contains no rule.
 */
const NODE_POSITIONS: Readonly<Record<string, { x: number; y: number }>> = {
  "SNS-ZONE-TEMP": { x: 105, y: 215 },
  "SNS-ZONE-RH": { x: 235, y: 215 },
  "SNS-CUA-VIB": { x: 455, y: 175 },
  "SNS-CUA-CURRENT": { x: 455, y: 275 },
  "SNS-CUA-LOAD": { x: 525, y: 275 },
  "SNS-CUA-RUN": { x: 595, y: 275 },
  "SNS-CUB-RUN": { x: 595, y: 350 },
  "SNS-OUTDOOR-TEMP": { x: 790, y: 140 },
};

const STATUS_FILL: Readonly<Record<string, string>> = {
  good: "var(--good-bg)",
  warn: "var(--warn-bg)",
  danger: "var(--danger-bg)",
  info: "var(--info-bg)",
  neutral: "var(--neutral-bg)",
  synthetic: "var(--synthetic-bg)",
};
const STATUS_STROKE: Readonly<Record<string, string>> = {
  good: "var(--good-ink)",
  warn: "var(--warn-ink)",
  danger: "var(--danger-ink)",
  info: "var(--info-ink)",
  neutral: "var(--neutral-ink)",
  synthetic: "var(--synthetic-ink)",
};

function shortValue(s: SimSensor): string {
  if (s.value === null) return "no data";
  if (typeof s.value === "boolean") return s.value ? "ON" : "OFF";
  if (s.signal === "temperature" || s.signal === "outdoor_temperature") {
    return `${((s.value * 9) / 5 + 32).toFixed(0)}°F`;
  }
  if (s.signal === "vibration_rms") return `${s.value.toFixed(2)} m/s²`;
  if (s.signal === "current") return `${s.value.toFixed(1)} A`;
  return `${s.value.toFixed(0)}${s.unit === "%" ? "%" : ` ${s.unit}`}`;
}

export function FacilityTwin({
  overview,
  selectedId,
  onSelect,
}: {
  readonly overview: SimOverview;
  readonly selectedId: string | null;
  readonly onSelect: (sensorId: string) => void;
}) {
  const sensors = overview.sensors;
  const byId = new Map(sensors.map((s) => [s.sensorId, s]));
  const asset = (kind: string) =>
    overview.facility.assets.find((a) => a.kind === kind)?.name ?? kind;
  const cuaRun = byId.get("SNS-CUA-RUN");
  const cubRun = byId.get("SNS-CUB-RUN");
  const stateText = (s: SimSensor | undefined) =>
    s === undefined || s.value === null
      ? "state unknown"
      : s.value === true
        ? "RUNNING"
        : "STOPPED";
  const activate = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <figure className="twin" data-testid="facility-twin">
      <svg
        viewBox="0 0 880 440"
        role="group"
        aria-label={`Facility diagram of ${overview.facility.name}. Select a sensor for its details.`}
        className="twin-svg"
      >
        <rect x="20" y="52" width="650" height="368" rx="10" className="twin-building" />
        <text x="36" y="76" className="twin-title">
          {overview.facility.name}
        </text>

        {/* Cold storage zone */}
        <rect x="46" y="96" width="310" height="300" rx="8" className="twin-zone" />
        <text x="60" y="120" className="twin-label">
          {asset("ZONE")}
        </text>
        <g className="twin-racks" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={70 + i * 70} y={260} width="46" height="110" rx="3" />
          ))}
        </g>

        {/* Cooling plant */}
        <rect x="386" y="96" width="262" height="300" rx="8" className="twin-plant" />
        <text x="400" y="120" className="twin-label">
          Cooling plant
        </text>
        <rect x="402" y="132" width="230" height="92" rx="6" className="twin-unit" />
        <text x="414" y="152" className="twin-label">
          {asset("COOLING_PRIMARY")}
        </text>
        <text x="414" y="212" className="twin-state" data-testid="cua-state">
          {stateText(cuaRun)}
        </text>
        <rect x="402" y="236" width="230" height="64" rx="6" className="twin-electrical" />
        <text x="414" y="256" className="twin-small">
          Electrical panel EP-1 (CU-A)
        </text>
        <rect
          x="402"
          y="312"
          width="230"
          height="72"
          rx="6"
          className="twin-unit twin-unit-backup"
        />
        <text x="414" y="332" className="twin-label">
          {asset("COOLING_BACKUP")}
        </text>
        <text x="414" y="374" className="twin-state" data-testid="cub-state">
          {stateText(cubRun)}
        </text>
        <path d="M 402 178 C 380 178, 380 200, 356 200" className="twin-pipe" aria-hidden="true" />

        {/* Outdoor / weather */}
        <rect x="690" y="52" width="170" height="130" rx="10" className="twin-outdoor" />
        <text x="702" y="76" className="twin-label">
          {asset("WEATHER")}
        </text>
        <text x="702" y="170" className="twin-small" data-testid="twin-weather-label">
          {overview.weather.display}
        </text>

        {sensors.map((s) => {
          const pos = NODE_POSITIONS[s.sensorId];
          if (pos === undefined) return null;
          const st = SENSOR_STATUS[s.status];
          const selected = selectedId === s.sensorId;
          const label = `${s.name}, ${s.assetName}: ${formatSensorValue(s)}. ${st.label}. Select for details.`;
          return (
            <g
              key={s.sensorId}
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-pressed={selected}
              data-testid={`node-${s.sensorId}`}
              data-status={s.status}
              className={`twin-node${selected ? " twin-node-selected" : ""}`}
              transform={`translate(${pos.x} ${pos.y})`}
              onClick={() => onSelect(s.sensorId)}
              onKeyDown={(e) => activate(e, s.sensorId)}
            >
              <circle
                r="17"
                fill={STATUS_FILL[st.tone]}
                stroke={STATUS_STROKE[st.tone]}
                strokeWidth={selected ? 4 : 2}
              />
              <text y="5" textAnchor="middle" className="twin-node-icon" aria-hidden="true">
                {st.icon}
              </text>
              <text y="34" textAnchor="middle" className="twin-node-value" aria-hidden="true">
                {shortValue(s)}
              </text>
              <text y="48" textAnchor="middle" className="twin-node-name" aria-hidden="true">
                {s.name.replace("Zone ", "").replace("CU-A ", "").replace("CU-B ", "")}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="twin-legend">
        {(["NORMAL", "WARNING", "CRITICAL", "LEARNING", "NO_DATA", "UNTRUSTED"] as const).map(
          (k) => (
            <span key={k} className={`badge tone-${SENSOR_STATUS[k].tone}`}>
              <span className="badge-icon" aria-hidden="true">
                {SENSOR_STATUS[k].icon}
              </span>
              <span>{SENSOR_STATUS[k].label}</span>
            </span>
          ),
        )}
        <span className="muted">
          Every value on this diagram is simulation data unless labelled LIVE WEATHER.
        </span>
      </figcaption>
    </figure>
  );
}
