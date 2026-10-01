import type { ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { STATUS, SEVERITY_MEANING } from "../lib/labels";
import type { StatusKey, Tone } from "../lib/labels";

/** Small presentational building blocks shared by every screen. Pure: props in, markup out. */

/** A status is always an icon AND a text label (never colour alone). */
export function StatusBadge({
  status,
  label,
  size = "md",
}: {
  readonly status: StatusKey;
  readonly label?: string;
  readonly size?: "md" | "lg";
}) {
  const s = STATUS[status];
  return (
    <span className={`badge tone-${s.tone} badge-${size}`} data-status={status}>
      <span className="badge-icon" aria-hidden="true">
        {s.icon}
      </span>
      <span>{label ?? s.label}</span>
    </span>
  );
}

export function ToneBadge({
  tone,
  icon,
  children,
}: {
  readonly tone: Tone;
  readonly icon?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className={`badge tone-${tone}`}>
      {icon !== undefined && (
        <span className="badge-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

const SEVERITY_TONE: Readonly<Record<string, Tone>> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MODERATE: "warn",
  LOW: "neutral",
};
const SEVERITY_ICON: Readonly<Record<string, string>> = {
  CRITICAL: "●●●",
  HIGH: "●●○",
  MODERATE: "●○○",
  LOW: "○○○",
};

export function SeverityBadge({ severity }: { readonly severity: string }) {
  return (
    <span
      className={`badge tone-${SEVERITY_TONE[severity] ?? "neutral"}`}
      title={SEVERITY_MEANING[severity]}
    >
      <span className="badge-icon" aria-hidden="true">
        {SEVERITY_ICON[severity] ?? "○○○"}
      </span>
      <span>{severity.charAt(0) + severity.slice(1).toLowerCase()}</span>
    </span>
  );
}

/** Synthetic or demonstration data is always labelled; it is never presented as real. */
export function SyntheticBadge({ label }: { readonly label?: string | undefined }) {
  return (
    <span className="badge tone-synthetic" title={label}>
      <span className="badge-icon" aria-hidden="true">
        ◇
      </span>
      <span>Synthetic demo data</span>
    </span>
  );
}

export function PageHeader({
  title,
  lead,
  children,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {lead !== undefined && <p className="lead">{lead}</p>}
      </div>
      {children !== undefined && <div className="page-header-aside">{children}</div>}
    </header>
  );
}

export function Notice({
  notice,
  error,
}: {
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
}) {
  if (notice === undefined && error === undefined) return null;
  return error !== undefined ? (
    <div id="feedback" className="notice notice-error" role="alert" tabIndex={-1}>
      <strong>That did not go through.</strong> {error}
    </div>
  ) : (
    <div id="feedback" className="notice notice-ok" role="status" tabIndex={-1}>
      {notice}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <h2>{title}</h2>
      {children !== undefined && <div>{children}</div>}
    </div>
  );
}

/** A failed API call, shown in words. The raw error and any stack trace are never rendered. */
export function ErrorState({ error }: { readonly error: ApiError }) {
  const unreachable = error.status === 0;
  return (
    <div className="empty empty-error" role="alert">
      <h2>{unreachable ? "The Symbiosis API is not reachable" : "This could not be loaded"}</h2>
      <p>{error.message}</p>
      {!unreachable && (
        <p className="muted">
          Status {error.status} · {error.code}
        </p>
      )}
    </div>
  );
}

/** Authorization denial from the API (403) or a case that is not visible to this identity (404). */
export function AccessDenied({
  title,
  children,
  homeHref,
  homeLabel,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly homeHref: string;
  readonly homeLabel: string;
}) {
  return (
    <div className="empty empty-denied" role="alert">
      <h2>{title}</h2>
      <div>{children}</div>
      <p>
        <a className="btn" href={homeHref}>
          {homeLabel}
        </a>
      </p>
    </div>
  );
}

export function Meter({
  value,
  label,
}: {
  readonly value: number;
  /** Visible description, e.g. "Evidence sufficiency". */
  readonly label: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{pct}%</strong>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Section({
  id,
  number,
  title,
  question,
  children,
  wide,
}: {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly question?: string;
  readonly children: ReactNode;
  readonly wide?: boolean;
}) {
  return (
    <section
      className={`section${wide === true ? " section-wide" : ""}`}
      aria-labelledby={`${id}-h`}
      id={id}
    >
      <h2 id={`${id}-h`}>
        <span className="section-number" aria-hidden="true">
          {number}
        </span>
        {title}
      </h2>
      {question !== undefined && <p className="section-question">{question}</p>}
      {children}
    </section>
  );
}
