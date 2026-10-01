import type { ApiError } from "../lib/api";
import { DENIAL_REASONS } from "../lib/labels";
import { PERSONA_LABELS, homeFor } from "../lib/identity";
import type { Session } from "../lib/identity";
import { AccessDenied, ErrorState } from "./ui";

/**
 * Turns a failed API call into a readable page. Authorization decisions are the API's: a 403 or an
 * insurer ACCESS_DENIED is shown as "not available to this identity", never as an error trace, and
 * a missing or other-tenant record is shown as "not found" (the API does not distinguish them).
 */
export function ApiErrorView({
  error,
  session,
  subject,
}: {
  readonly error: ApiError;
  readonly session: Session | undefined;
  /** What was being opened, e.g. "this case". */
  readonly subject: string;
}) {
  const homeHref = session === undefined ? "/" : homeFor(session.persona);
  const homeLabel =
    session === undefined
      ? "Choose a demo identity"
      : `Go to ${PERSONA_LABELS[session.persona]} workspace`;

  if (error.code === "ACCESS_DENIED") {
    const r = DENIAL_REASONS[error.reason ?? ""] ?? DENIAL_REASONS.NO_AGREEMENT_FOR_TARGET;
    return (
      <AccessDenied
        title={r?.title ?? "Not shared with you"}
        homeHref={homeHref}
        homeLabel={homeLabel}
      >
        <p>{r?.text}</p>
        <p className="muted">
          Access is decided by the customer&apos;s sharing agreement and is checked on every
          request.
        </p>
      </AccessDenied>
    );
  }
  if (error.status === 401) {
    return (
      <AccessDenied title="Choose a demo identity" homeHref="/" homeLabel="Choose a demo identity">
        <p>This area needs a development identity. Pick one from the switcher at the top.</p>
      </AccessDenied>
    );
  }
  if (error.status === 403) {
    return (
      <AccessDenied
        title="Not available to this identity"
        homeHref={homeHref}
        homeLabel={homeLabel}
      >
        <p>
          {session !== undefined ? (
            <>
              You are signed in as <strong>{session.roleLabel}</strong> (
              {PERSONA_LABELS[session.persona]}). That role is not permitted to open {subject}.
            </>
          ) : (
            <>This identity is not permitted to open {subject}.</>
          )}
        </p>
        <p className="muted">The API enforced this; the page only reports it.</p>
      </AccessDenied>
    );
  }
  if (error.status === 404) {
    return (
      <AccessDenied title="Not found" homeHref={homeHref} homeLabel={homeLabel}>
        <p>
          {subject.charAt(0).toUpperCase() + subject.slice(1)} does not exist, or is not visible to
          this identity.
        </p>
      </AccessDenied>
    );
  }
  return <ErrorState error={error} />;
}
