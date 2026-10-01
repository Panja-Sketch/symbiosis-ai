import { grantSharingAction, revokeSharingAction } from "../app/actions";
import { formatTime } from "../lib/format";
import { orgLabel, personLabel } from "../lib/identity";
import type { OrgNames, People } from "../lib/identity";
import { AGREEMENT_STATUS_LABELS, SCOPE_INFO, STANDARD_SCOPES } from "../lib/labels";
import type { AgreementDto, ConsentScope, OrganizationDto, SharingState } from "../lib/types";
import { ToneBadge } from "./ui";
import type { Tone } from "../lib/labels";

const SHARING_TONE: Readonly<Record<SharingState, { tone: Tone; icon: string; label: string }>> = {
  NOT_SHARED: { tone: "neutral", icon: "–", label: "Not shared · no evidence package yet" },
  SHAREABLE: { tone: "info", icon: "◔", label: "Shareable · nothing shared with anyone" },
  SHARED: { tone: "good", icon: "✓", label: "Shared under an active agreement" },
  REVOKED: { tone: "warn", icon: "✕", label: "Revoked · no active agreement remains" },
};

const AGREEMENT_TONE: Readonly<Record<string, Tone>> = {
  ACTIVE: "good",
  REVOKED: "warn",
  EXPIRED: "neutral",
  NOT_YET_EFFECTIVE: "info",
};

const GROUPS: readonly { id: "summary" | "verification" | "evidence"; title: string }[] = [
  { id: "summary", title: "What happened" },
  { id: "verification", title: "Whether it worked" },
  { id: "evidence", title: "The evidence itself" },
];

function ScopeList({ scopes }: { readonly scopes: readonly ConsentScope[] }) {
  return (
    <ul className="scope-chips" aria-label="Scopes shared">
      {scopes.map((s) => (
        <li key={s} title={SCOPE_INFO[s].plain}>
          {SCOPE_INFO[s].label}
        </li>
      ))}
    </ul>
  );
}

export function AgreementList({
  agreements,
  orgNames,
  people,
  canManage,
  returnTo,
}: {
  readonly agreements: readonly AgreementDto[];
  readonly orgNames: OrgNames;
  readonly people: People;
  readonly canManage: boolean;
  readonly returnTo: string;
}) {
  if (agreements.length === 0) {
    return <p className="muted">No sharing agreements cover this yet.</p>;
  }
  return (
    <ul className="agreements">
      {agreements.map((g) => {
        const a = g.agreement;
        const revocable = g.status === "ACTIVE" || g.status === "NOT_YET_EFFECTIVE";
        return (
          <li key={a.agreementId} className="agreement" data-status={g.status}>
            <div className="agreement-head">
              <strong>{orgLabel(orgNames, a.recipientOrganizationId)}</strong>
              <ToneBadge
                tone={AGREEMENT_TONE[g.status] ?? "neutral"}
                icon={g.status === "ACTIVE" ? "✓" : g.status === "REVOKED" ? "✕" : "–"}
              >
                {AGREEMENT_STATUS_LABELS[g.status] ?? g.status}
              </ToneBadge>
            </div>
            <ScopeList scopes={a.scopes} />
            <p className="muted">
              Effective {formatTime(a.effectiveFrom)} ·{" "}
              {a.expiresAt !== undefined ? `expires ${formatTime(a.expiresAt)}` : "until revoked"}
              {a.revokedAt !== undefined && (
                <>
                  {" "}
                  · revoked {formatTime(a.revokedAt)}
                  {a.revokedBy !== undefined && <> by {personLabel(people, a.revokedBy)}</>}
                </>
              )}
            </p>
            {revocable && canManage && (
              <form action={revokeSharingAction} className="inline-form">
                <input type="hidden" name="agreementId" value={a.agreementId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button type="submit" className="btn btn-danger btn-small">
                  Revoke access for {orgLabel(orgNames, a.recipientOrganizationId)}
                </button>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Consent, in plain language. Sharing evidence is not sharing telemetry: the insurer receives only
 * the scopes ticked here, and raw telemetry is a separate advanced choice that is never selected
 * by default.
 */
export function SharingPanel({
  caseId,
  facilityId,
  sharingState,
  agreements,
  hasPackage,
  canManage,
  canGrantRaw,
  insurers,
  orgNames,
  people,
  returnTo,
}: {
  readonly caseId: string;
  readonly facilityId: string;
  readonly sharingState: SharingState;
  readonly agreements: readonly AgreementDto[];
  readonly hasPackage: boolean;
  readonly canManage: boolean;
  readonly canGrantRaw: boolean;
  readonly insurers: readonly OrganizationDto[];
  readonly orgNames: OrgNames;
  readonly people: People;
  readonly returnTo: string;
}) {
  const st = SHARING_TONE[sharingState];
  return (
    <div className="sharing" data-testid="sharing-panel" data-sharing-state={sharingState}>
      <p>
        <ToneBadge tone={st.tone} icon={st.icon}>
          {st.label}
        </ToneBadge>
      </p>
      <p>
        You decide what an insurer can see. Sharing evidence is not sharing your telemetry: the
        insurer receives only the scopes you choose, for the facility you choose, and you can revoke
        access at any time. Revoking ends their access on their very next request; the evidence
        package itself is never altered or deleted.
      </p>
      <AgreementList
        agreements={agreements}
        orgNames={orgNames}
        people={people}
        canManage={canManage}
        returnTo={returnTo}
      />
      {!hasPackage ? (
        <p className="muted">
          There is nothing to share yet: an evidence package is created when verification completes.
        </p>
      ) : !canManage ? (
        <p className="muted">Your role can see sharing but cannot grant or revoke it.</p>
      ) : insurers.length === 0 ? (
        <p className="muted">No insurer organizations are available to share with.</p>
      ) : (
        <form
          action={grantSharingAction}
          className="grant-form"
          aria-labelledby={`grant-${caseId}`}
        >
          <h3 id={`grant-${caseId}`}>Share this evidence with an insurer</h3>
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="facilityId" value={facilityId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="field">
            Insurer
            <select name="recipientOrganizationId" defaultValue={insurers[0]?.organizationId}>
              {insurers.map((o) => (
                <option key={o.organizationId} value={o.organizationId}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          {GROUPS.map((g) => (
            <fieldset key={g.id} className="scope-group">
              <legend>{g.title}</legend>
              {STANDARD_SCOPES.filter((s) => SCOPE_INFO[s].group === g.id).map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" name="scope" value={s} defaultChecked />
                  <span>
                    <strong>{SCOPE_INFO[s].label}</strong>
                    <span className="muted"> {SCOPE_INFO[s].plain}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <details className="advanced">
            <summary>Advanced: raw telemetry</summary>
            {canGrantRaw ? (
              <label className="check">
                <input type="checkbox" name="scope" value="RAW_TELEMETRY" />
                <span>
                  <strong>{SCOPE_INFO.RAW_TELEMETRY.label}</strong>
                  <span className="muted"> {SCOPE_INFO.RAW_TELEMETRY.plain}</span>
                </span>
              </label>
            ) : (
              <p className="muted">
                Sharing raw telemetry needs a separate permission that your role does not have.
              </p>
            )}
          </details>
          <label className="field">
            Access ends on (optional)
            <input type="date" name="expiresOn" />
            <span className="muted">Leave empty to share until you revoke.</span>
          </label>
          <button type="submit" className="btn btn-primary">
            Share selected evidence
          </button>
        </form>
      )}
    </div>
  );
}
