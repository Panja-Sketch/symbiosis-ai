import { switchIdentity } from "../app/actions";
import { PERSONA_LABELS, homeFor, personaOf, roleLabel } from "../lib/identity";
import type { Persona, Session } from "../lib/identity";
import type { DirectoryDto, IdentityDto } from "../lib/types";
import { FlowStrip } from "./FlowStrip";

const BLURB: Readonly<Record<Persona, { readonly asks: readonly string[]; readonly cta: string }>> =
  {
    FACILITY: {
      asks: [
        "What happened and how urgent is it?",
        "What should I do, and who owns it?",
        "Did it actually work, and is it staying fixed?",
        "What evidence exists, and what am I sharing with the insurer?",
      ],
      cta: "Open Operations",
    },
    INSURER: {
      asks: [
        "Which locations need attention, and which risks are unresolved?",
        "Which mitigations are actually verified, and which recurred?",
        "Where does a risk engineer need to review?",
        "What has the customer consented to share, and can the package be trusted?",
      ],
      cta: "Open Risk Evidence",
    },
  };

function IdentityButton({ a, current }: { readonly a: IdentityDto; readonly current: boolean }) {
  return (
    <form action={switchIdentity}>
      <input type="hidden" name="actorId" value={a.actorId} />
      <button type="submit" className={`btn${current ? " btn-primary" : ""}`}>
        Continue as {a.roles.map(roleLabel).join(", ")}
        <span className="btn-sub">{a.actorId}</span>
      </button>
    </form>
  );
}

/** The entry page: the product claim, the flow, and one door per persona. */
export function Landing({
  directory,
  session,
}: {
  readonly directory: DirectoryDto;
  readonly session: Session | undefined;
}) {
  const orgName = (id: string) =>
    directory.organizations.find((o) => o.organizationId === id)?.name ?? id;
  const personas: readonly Persona[] = ["FACILITY", "INSURER"];
  const primaryOrgs: Readonly<Record<Persona, string>> = {
    FACILITY: "ORG-SIM-001",
    INSURER: "ORG-INS-001",
  };
  const others = directory.actors.filter(
    (a) => a.organizationId !== primaryOrgs.FACILITY && a.organizationId !== primaryOrgs.INSURER,
  );
  return (
    <>
      <section className="hero" aria-labelledby="hero-h">
        <p className="eyebrow">Risk Improvement Verification Platform</p>
        <h1 id="hero-h">
          A recommendation to reduce risk is not the same as verified risk reduction.
        </h1>
        <p className="lead">
          Symbiosis detects a risk, helps people act on it, then uses trusted sensor evidence to
          check whether the risk actually went down, and proves it. Conclusions are deterministic;
          people act; sensors verify; the customer controls what an insurer sees.
        </p>
        <FlowStrip />
      </section>
      {session !== undefined && (
        <p className="notice notice-ok" role="status">
          You are using the demo as <strong>{session.roleLabel}</strong> ({session.organizationName}
          ). <a href={homeFor(session.persona)}>Continue to your workspace</a>
        </p>
      )}
      <div className="persona-grid">
        {personas.map((p) => (
          <section key={p} className="card persona-card" aria-labelledby={`persona-${p}`}>
            <h2 id={`persona-${p}`}>{PERSONA_LABELS[p]}</h2>
            <p className="muted">
              {orgName(primaryOrgs[p])} · same Risk Improvement Case, different questions:
            </p>
            <ul className="plain-list">
              {BLURB[p].asks.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
            <div className="identity-buttons">
              {directory.actors
                .filter((a) => a.organizationId === primaryOrgs[p] && personaOf(a) === p)
                .map((a) => (
                  <IdentityButton key={a.actorId} a={a} current={session?.actorId === a.actorId} />
                ))}
            </div>
          </section>
        ))}
      </div>
      <details className="card isolation">
        <summary>Isolation checks: identities from other organizations</summary>
        <p className="muted">
          These synthetic identities belong to other organizations. They exist to show that a tenant
          cannot see another tenant&apos;s cases, and that an insurer sees only what was shared with
          it.
        </p>
        <div className="identity-buttons">
          {others.map((a) => (
            <IdentityButton key={a.actorId} a={a} current={session?.actorId === a.actorId} />
          ))}
        </div>
      </details>
    </>
  );
}
