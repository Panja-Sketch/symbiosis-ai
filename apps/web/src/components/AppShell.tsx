import type { ReactNode } from "react";
import { signOut, switchIdentity } from "../app/actions";
import { SignOutButton } from "./firebase-session-sync";
import type { AuthMode } from "../lib/auth-mode";
import { PERSONA_LABELS, roleLabel } from "../lib/identity";
import type { Persona, Session } from "../lib/identity";
import type { DirectoryDto } from "../lib/types";
import { NavLinks, ReturnToField } from "./NavLinks";
import type { NavItem } from "./NavLinks";

export const NAV: Readonly<Record<Persona, readonly NavItem[]>> = {
  FACILITY: [
    { href: "/operations", label: "Operations" },
    { href: "/operations/evidence", label: "Evidence & sharing" },
    { href: "/trust", label: "Trust & evidence" },
  ],
  INSURER: [
    { href: "/risk-evidence", label: "Risk Evidence" },
    { href: "/risk-evidence/sites", label: "Sites" },
    { href: "/risk-evidence/interventions", label: "Interventions" },
    { href: "/trust", label: "Trust & evidence" },
  ],
};

/** Development identity switcher: a plain form over the server-side synthetic directory. */
export function IdentitySwitcher({
  directory,
  session,
}: {
  readonly directory: DirectoryDto;
  readonly session: Session | undefined;
}) {
  const byOrg = directory.organizations
    .map((o) => ({
      org: o,
      actors: directory.actors.filter((a) => a.organizationId === o.organizationId),
    }))
    .filter((g) => g.actors.length > 0);
  return (
    <form action={switchIdentity} className="switcher">
      <ReturnToField />
      <label htmlFor="actorId">
        <span className="badge tone-synthetic">
          <span className="badge-icon" aria-hidden="true">
            ◇
          </span>
          <span>Demo identity</span>
        </span>
      </label>
      <select id="actorId" name="actorId" defaultValue={session?.actorId ?? ""}>
        {session === undefined && (
          <option value="" disabled>
            Choose an identity…
          </option>
        )}
        {byOrg.map(({ org, actors }) => (
          <optgroup key={org.organizationId} label={org.name}>
            {actors.map((a) => (
              <option key={a.actorId} value={a.actorId}>
                {a.roles.map(roleLabel).join(", ")} ({a.actorId})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="submit" className="btn btn-small">
        Switch
      </button>
    </form>
  );
}

export function AppShell({
  session,
  directory,
  mode = "demo",
  children,
}: {
  readonly session: Session | undefined;
  readonly directory: DirectoryDto | undefined;
  readonly mode?: AuthMode;
  readonly children: ReactNode;
}) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="demo-banner" role="note">
        {mode === "token" ? (
          <>
            <strong>Cloud prototype.</strong> Synthetic data; signed in with a verified identity.
          </>
        ) : (
          <>
            <strong>Local demo.</strong> Synthetic data and a development identity, not production
            authentication.
          </>
        )}
      </div>
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>
            <strong>Symbiosis AI</strong>
            <span className="brand-sub">Risk Improvement Verification</span>
          </span>
        </a>
        {session !== undefined && (
          <nav className="nav" aria-label={`${PERSONA_LABELS[session.persona]} navigation`}>
            <NavLinks items={NAV[session.persona]} />
          </nav>
        )}
        <div className="topbar-right">
          {session !== undefined && (
            <p className="context" data-testid="context">
              <span className="context-persona">{PERSONA_LABELS[session.persona]}</span>
              <span className="context-org">
                {session.roleLabel} · {session.organizationName}
                {session.facilityIds !== "ALL" && session.facilityIds.length > 0
                  ? ` · ${session.facilityIds.join(", ")}`
                  : session.persona === "FACILITY"
                    ? " · all facilities"
                    : ""}
              </span>
            </p>
          )}
          {directory !== undefined && <IdentitySwitcher directory={directory} session={session} />}
          {session !== undefined && mode === "token" && <SignOutButton />}
          {session !== undefined && mode === "demo" && (
            <form action={signOut}>
              <button type="submit" className="btn btn-small btn-quiet">
                Clear identity
              </button>
            </form>
          )}
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        {children}
      </main>
      <footer className="footer">
        <p>
          Symbiosis AI is a risk improvement <em>verification</em> platform. A recommendation is not
          the same as verified risk reduction. Conclusions are deterministic; people act; sensors
          verify.
        </p>
      </footer>
    </div>
  );
}
