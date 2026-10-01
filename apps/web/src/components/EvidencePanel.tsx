import { formatTime, shortHash } from "../lib/format";
import { STATUS_FOR_RESULT, STATUS } from "../lib/labels";
import type { EvidenceDetailDto, EvidenceRecordDto } from "../lib/types";
import { StatusBadge, SyntheticBadge, ToneBadge } from "./ui";

const KIND_LABELS: Readonly<Record<string, string>> = {
  OBSERVATION: "sensor observations",
  BASELINE: "baselines",
  ACTION: "actions",
  AUDIT: "audit entries",
  POLICY: "policy snapshots",
  DEVICE: "device snapshots",
};

function kindCounts(artifacts: readonly { readonly kind: string }[]): readonly [string, number][] {
  const m = new Map<string, number>();
  for (const a of artifacts) m.set(a.kind, (m.get(a.kind) ?? 0) + 1);
  return [...m.entries()];
}

/**
 * The evidence package behind a verification: what exists, what it proves, whether its hash still
 * checks out (recomputed by the API when this page loaded) and that it is synthetic. Raw
 * observations are counted here, never listed.
 */
export function EvidencePanel({
  packages,
  detail,
  error,
  verificationPending,
  restricted,
}: {
  readonly packages: readonly EvidenceRecordDto[];
  readonly detail?: EvidenceDetailDto | undefined;
  readonly error?: string | undefined;
  readonly verificationPending: boolean;
  /** The role may not read evidence packages (the API left them out). */
  readonly restricted?: boolean;
}) {
  if (restricted === true) {
    return (
      <div className="empty-inline" data-testid="evidence-restricted">
        <p>
          <strong>Evidence is not available to your role.</strong> A facility manager, organization
          admin or auditor can view evidence packages.
        </p>
      </div>
    );
  }
  if (packages.length === 0) {
    return (
      <div className="empty-inline" data-testid="no-evidence">
        <p>
          <strong>No evidence package yet.</strong>{" "}
          {verificationPending
            ? "Verification is still pending. A package is created automatically when it completes, whatever the result."
            : "A package is created automatically when a verification completes."}
        </p>
      </div>
    );
  }
  const record = detail?.record ?? packages.at(-1);
  if (record === undefined) return null;
  const result = STATUS_FOR_RESULT[record.result];
  const counts = detail === undefined ? [] : kindCounts(detail.package.manifest.artifacts);
  const total = detail?.package.manifest.artifacts.length;
  return (
    <div className="evidence" data-testid="evidence-panel">
      <dl className="kv">
        <div>
          <dt>Evidence package</dt>
          <dd>
            <code>{record.packageId}</code>
          </dd>
        </div>
        <div>
          <dt>What it records</dt>
          <dd>
            {result !== undefined ? (
              <StatusBadge status={result} label={`Result: ${STATUS[result].label}`} />
            ) : (
              record.result
            )}
          </dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd>{formatTime(record.createdAt)}</dd>
        </div>
        {detail !== undefined && (
          <div>
            <dt>Verification policy</dt>
            <dd>
              {detail.package.payload.verification.policyId} v
              {detail.package.payload.verification.policyVersion}
            </dd>
          </div>
        )}
        <div>
          <dt>Integrity</dt>
          <dd>
            {detail === undefined ? (
              <ToneBadge tone="warn" icon="?">
                Not checked: {error ?? "package details unavailable"}
              </ToneBadge>
            ) : detail.integrity.valid ? (
              <ToneBadge tone="good" icon="✓">
                Hash check passed (SHA-256, recomputed on load)
              </ToneBadge>
            ) : (
              <ToneBadge tone="danger" icon="✕">
                Hash check FAILED: {detail.integrity.issues.join("; ")}
              </ToneBadge>
            )}
          </dd>
        </div>
        <div>
          <dt>Data origin</dt>
          <dd>
            {detail?.package.payload.source.synthetic === false ? (
              <span>{detail.package.payload.source.label}</span>
            ) : (
              <>
                <SyntheticBadge label={detail?.package.payload.source.label} />
                {detail !== undefined && (
                  <span className="cell-sub">{detail.package.payload.source.label}</span>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Package contents</dt>
          <dd>
            {total === undefined
              ? "—"
              : `${total} records: ${counts.map(([k, n]) => `${n} ${KIND_LABELS[k] ?? k.toLowerCase()}`).join(", ")}`}
          </dd>
        </div>
        <div>
          <dt>Hashes</dt>
          <dd>
            <span className="hash" title={record.payloadSha256}>
              payload {shortHash(record.payloadSha256)}
            </span>
            <span className="hash" title={record.manifestSha256}>
              manifest {shortHash(record.manifestSha256)}
            </span>
          </dd>
        </div>
      </dl>
      <p className="muted">
        The package freezes the facts used for the verification. It proves what the sensors showed
        and what was reported at that time; it does not prove anything beyond them. Raw sensor
        readings are inside the package but are not shown or shared here.
      </p>
      {packages.length > 1 && (
        <details className="history">
          <summary>{packages.length} packages for this case</summary>
          <ul className="plain-list">
            {[...packages].reverse().map((p) => (
              <li key={p.packageId}>
                <code>{p.packageId}</code> ·{" "}
                {STATUS_FOR_RESULT[p.result] !== undefined
                  ? STATUS[STATUS_FOR_RESULT[p.result] as keyof typeof STATUS].label
                  : p.result}{" "}
                · {formatTime(p.createdAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
