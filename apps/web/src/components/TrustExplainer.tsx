/**
 * Plain statements about how the evidence is produced and controlled. Every line describes
 * behaviour that exists in the product today (S0–S6); nothing here claims a certification, legal
 * effect or security property that has not been built.
 */
export const TRUST_POINTS: readonly { readonly title: string; readonly text: string }[] = [
  {
    title: "Conclusions are deterministic",
    text: "Detection, verification, recurrence and the risk-engineer recommendation are produced by versioned rules and thresholds, never by an AI model. The same data and policy give the same result.",
  },
  {
    title: "Verification uses sensor evidence",
    text: "A person reporting an action is recorded, but it is not proof. A result of Verified improved needs new, trusted sensor readings after the action that meet the policy.",
  },
  {
    title: "Packages are checked with SHA-256",
    text: "Each evidence package is stored as canonical JSON with a SHA-256 manifest. The hash is recomputed when the package is read; any change to its content fails the check. Hashes show change, not authorship: packages are not yet digitally signed.",
  },
  {
    title: "The customer controls sharing",
    text: "Evidence is shared only through a scoped agreement the customer creates, and it can be revoked at any time. An insurer sees only the scopes granted, and access ends on the next read after revocation or expiry.",
  },
  {
    title: "Raw telemetry is not shared by default",
    text: "Individual sensor readings are a separate, advanced scope that is off unless explicitly chosen. Ordinary evidence scopes only ever count them.",
  },
  {
    title: "Synthetic data is labelled",
    text: "Everything in this demo comes from a simulator and a development identity. Every evidence package carries a synthetic-data label, and the interface repeats it.",
  },
];

export function TrustExplainer({ open }: { readonly open?: boolean }) {
  return (
    <details className="trust" {...(open === true ? { open: true } : {})}>
      <summary>Can this evidence be trusted? How it works</summary>
      <ul className="trust-list">
        {TRUST_POINTS.map((p) => (
          <li key={p.title}>
            <strong>{p.title}.</strong> {p.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
