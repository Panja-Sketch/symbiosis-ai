import { FlowStrip } from "../../components/FlowStrip";
import { TRUST_POINTS } from "../../components/TrustExplainer";
import { PageHeader } from "../../components/ui";

export const metadata = { title: "Trust & evidence" };

const NOT_CLAIMED = [
  "Symbiosis does not control equipment. People act; the system recommends.",
  "Symbiosis does not underwrite, price or change coverage, and a recommendation never schedules or dispatches a risk engineer.",
  "No AI model decides risk, verification, recurrence or any recommendation level.",
  "Packages are not yet digitally signed: a hash shows that content changed, not who produced it.",
];

export default function TrustPage() {
  return (
    <>
      <PageHeader
        title="Trust & evidence"
        lead="How a conclusion is reached, what an evidence package proves, and who controls it."
      />
      <FlowStrip />
      <section aria-labelledby="how-h">
        <h2 id="how-h">How it works</h2>
        <ul className="trust-list trust-page">
          {TRUST_POINTS.map((p) => (
            <li key={p.title} className="card">
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="not-h">
        <h2 id="not-h">What Symbiosis does not claim</h2>
        <ul className="plain-list">
          {NOT_CLAIMED.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
