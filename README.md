# Symbiosis AI

A vendor-neutral, human-in-the-loop continuous risk **verification** platform for property
insurers and insured businesses. See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the locked
architecture (single source of truth).

## Status

Phases **S0** (foundation), **S1** (domain core), **S2** (local ingestion), **S3** (detection +
baselines), **S4** (operations workflow), **S5** (verification + recurrence + intervention
prioritization) **S6** (evidence + consent), **S7** (persona UI) **S8** (grounded Gemini explanations) and **S9** (Google Cloud production adapters and deployment) are complete. A simulated device is authenticated, normalized and assessed; a
deterministic rule detects persistent compound deterioration and opens a Risk Improvement Case; an
alert goes out through a local notification port (ConsoleEmail); a person acknowledges, an approved
action is assigned and reported, and the case waits as **VERIFICATION PENDING**. A reported action
is **never** evidence that the risk improved: a deterministic verification over trusted
post-action sensor readings (versioned policy in `config/verification-policy/`) concludes
`VERIFIED`, `PARTIALLY_VERIFIED`, `NOT_IMPROVING` or `INCONCLUSIVE`, history is kept, and if the
same hazard returns inside the recurrence-watch window the **same** case is `REOPENED`. A
deterministic, versioned risk-engineer intervention recommendation (decision support only) is
recalculated on material events. Every completed verification now produces an **immutable
evidence package** (canonical JSON, SHA-256 manifest, frozen device facts, explicit
synthetic-data label) that preserves its actual result; the insured controls what an insurer
sees through scoped, revocable **sharing agreements**, raw telemetry is off by default, and
every insurer read is authorization-checked and audited. The system deliberately stops there:
S7 added the Next.js persona web app, S8 a strictly bounded explanation layer (AI explains, never decides), and S9 the cloud runtime: the same services on Firestore, Pub/Sub, Cloud Storage, Secret Manager and Firebase Auth, deployed to Cloud Run (see [docs/GCP_RUNTIME.md](docs/GCP_RUNTIME.md)). **No hardware integration (S10) yet.** Progress is tracked in
[docs/IMPLEMENTATION_STATE.md](docs/IMPLEMENTATION_STATE.md).

## Layout

`apps/` (web, api, worker, simulator) · `packages/` (logical modules) · `adapters/` ·
`config/` (versioned policies) · `firmware/` · `firmware-contracts/` · `infrastructure/` ·
`tests/` · `docs/`. See spec §44.

## Commands

Requires Node >= 20 and pnpm 12.

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

## Running locally (S2-S7)

```
pnpm dev          # api + worker (one process, in-memory bus), the simulator and the web app (:3000)
pnpm smoke:s2     # self-checking ingestion run over real HTTP, exits non-zero on failure
pnpm smoke:s3     # baseline -> isolated anomalies -> compound deterioration -> one case
pnpm smoke:s4     # detected -> alert -> acknowledge -> assign -> report -> VERIFICATION PENDING
pnpm smoke:s5     # ... -> trusted post-action data -> VERIFIED -> hazard returns -> same case REOPENED
pnpm smoke:s6     # ... VERIFIED -> evidence package + hashes -> SHAREABLE -> consent -> insurer read -> revoke
pnpm smoke:s7     # builds the web app, then drives both personas in a real browser (incl. phone width)
pnpm test:e2e     # builds the web app, then the 26 Playwright browser tests
pnpm smoke:s8     # grounded explanations: Gemini adapter over a scripted endpoint, consent, fallback
```

`pnpm dev` listens on `http://127.0.0.1:8787` (override with `EDGE_PORT`) and prints each
telemetry event as the simulator signed packets flow through. The **web app** also starts, on
`http://127.0.0.1:3000` (`WEB_PORT`); api and worker share a process only because the local
event bus is in-memory. Everything uses a public, obviously synthetic dev device (`DEV-SIM-001`);
no real credentials exist in the repo.

Edge endpoints: `POST /edge/v1/telemetry` and `POST /edge/v1/heartbeat`, signed per
PROJECT_SPEC section 32. A known-answer signing vector for firmware is in
`firmware-contracts/sample-packets/signing-vector.json`.

## Secrets

Never commit secrets. `.env.example` lists placeholder names only; production secrets will use
Google Secret Manager.

## Working with Claude

Read [CLAUDE.md](CLAUDE.md) and [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) first.

Choose what the simulator sends with `SIMULATOR_SCENARIO` (`normal`, `isolated-vibration`,
`isolated-current`, `context-only`, `compound-outdoor-heat`, `compound-rising-temperature`), e.g.
`SIMULATOR_SCENARIO=compound-outdoor-heat pnpm dev`. With real time the baseline needs its 2
minute warm-up before detection can conclude anything; `pnpm smoke:s3` and the tests use a
simulated clock instead of waiting. Baseline and rule thresholds live in `config/rules/`
(`baselines.v1.json`, `cooling-electrical.v1.json`, `data-quality.v1.json`).

### Operations workflow (S4)

With `pnpm dev` running, open `http://127.0.0.1:8787/ui/cases?actor=USR-FACILITY-MGR-001` (a
minimal, read-only workflow-proof page; the real UI is S7). The JSON API is under `/api/v1`:
`GET /cases`, `GET /cases/:id`, `POST /cases/:id/acknowledge`, `POST /cases/:id/assignments`,
`POST /cases/:id/actions`, `POST /cases/:id/actions/:actionId/acknowledge`,
`POST /cases/:id/dismiss`, and `POST /ops/tick` (escalation + alert retries; ORG_ADMIN).

**Development identity only:** callers are identified by the `X-Demo-Actor-Id` header (or
`?actor=` on pages) against a synthetic in-memory directory (`USR-FACILITY-MGR-001`,
`USR-OPERATOR-001`, `USR-ORG-ADMIN-001`, `USR-AUDITOR-001`, and one actor in another organization).
It is not authentication. Alerts are printed by ConsoleEmail; nothing is emailed. Escalation
deadlines, retry settings and recipient roles are in `config/escalation/`, and the approved,
recommend-only actions are in `config/action-library/`. `OPS_TICK_INTERVAL_MS` sets the dev
scheduler stand-in (default 10 s).

### Verification, recurrence and intervention recommendations (S5)

Verification is driven by the scheduler seam: `runtime.tick()` (in `pnpm dev` every
`OPS_TICK_INTERVAL_MS`; also `POST /api/v1/ops/tick`, ORG_ADMIN) starts a verification for each
case whose action was reported, then completes every verification whose post-action window has
ended. Nothing is concluded before the window ends, and tests use simulated time. The policy
(window, minimum observations, required signals, missingness, sustained duration, hysteresis,
recurrence-watch window) is `config/verification-policy/cooling-electrical.v1.json`; the
intervention policy is `config/intervention-policy/risk-engineer-prioritization.v1.json`.
`SIMULATOR_SCENARIO` also accepts `partial-improvement` and `backup-running`.

Added API (same development identity): `GET /api/v1/verifications/:id`,
`GET /api/v1/interventions`, `GET /api/v1/interventions/:id`,
`POST /api/v1/interventions/:id/acknowledge`. The case page now shows "Did it work?" (pending or the
result with criteria, before/after values, completeness, confidence and evidence-reference count),
"Is it staying fixed?" (recurrence watch and count) and the deterministic intervention
recommendation (Remote Monitoring, Remote Review, Risk Engineer Review, Site Visit Recommended). A
recommendation is decision support only: it schedules nobody and changes no underwriting, premium
or coverage.

### Evidence and consent (S6)

A completed verification (any result) is turned into an immutable evidence package by the
worker (`evidence.package_created`, case `latestEvidencePackageId`, then `evidence.shareable`);
the case is then `SHAREABLE`, **never** `SHARED` merely because a package exists. The format,
canonical serialization, hashes and snapshot rules are in
[docs/EVIDENCE_STANDARD.md](docs/EVIDENCE_STANDARD.md). Try it with `pnpm dev`:

- Insured side (development identity `USR-FACILITY-MGR-001`; `USR-ORG-ADMIN-001` may also grant raw
  telemetry): `GET /api/v1/evidence/:id`, `POST /api/v1/sharing-agreements`
  (`{recipientOrganizationId, facilityIds, scopes, effectiveFrom?, expiresAt?}`),
  `POST /api/v1/sharing-agreements/:id/revoke`, plus `GET /api/v1/sharing-agreements[/:id]`. The
  case page `/ui/cases/:id?actor=USR-FACILITY-MGR-001` shows the latest package (id, result,
  policy, time, hashes with a live hash check, synthetic label), the sharing state, and grant and
  revoke forms.
- Insurer side (`USR-RISK-ENGINEER-001`, `USR-UNDERWRITER-001`; recipient organization
  `ORG-INS-001`): `GET /insurance/v1/sites`, `/sites/:id/cases`, `/cases/:id`,
  `/cases/:id/evidence` (add `?include=raw_telemetry` only with an explicit `RAW_TELEMETRY` scope),
  `/recommendations`, `/interventions`; page `/ui/insurer/cases?actor=USR-RISK-ENGINEER-001`.
  Every result is consent-filtered and audited; there is no sensor dashboard.

Scopes: `RECOMMENDATION`, `EVENT_SUMMARY`, `ACTION_SUMMARY`, `BEFORE_AFTER_METRICS`,
`VERIFICATION_RESULT`, `VERIFICATION_CONFIDENCE`, `RECURRENCE_STATUS`, `EVIDENCE_ARTIFACTS`,
`INTERVENTION_RECOMMENDATION`, and the separate, off-by-default `RAW_TELEMETRY`. A revoked,
expired or not-yet-effective agreement, another recipient, another facility or a missing scope
is denied on the very next read. Everything is synthetic and local (in-memory stores and object
store); no cloud service is used.

### Persona web app (S7)

`apps/web` is a Next.js 16 app (App Router, React 19, plain CSS; decisions D-056 to D-063). Open
`http://127.0.0.1:3000` after `pnpm dev` and pick a **demo identity** (a development identity, not
authentication; the shell labels it). It never reads a repository: server components and Server
Actions call `/api/v1` (facility) and `/insurance/v1` (insurer) over HTTP, and the browser never
talks to the API. `SYMBIOSIS_API_URL` (default `http://127.0.0.1:8787`) points it at the API.

| Route                                                                         | Persona  | Purpose                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                           | both     | The product claim, the DETECT to MONITOR flow, one door per persona                                                                                             |
| `/operations`                                                                 | facility | Summary cards, filterable case list                                                                                                                             |
| `/operations/cases/[id]`                                                      | facility | Case detail: what happened, why it matters, what to do, accountability, what was done, did it work?, is it staying fixed?, evidence, sharing, timeline          |
| `/operations/evidence`                                                        | facility | Evidence packages and who can see them                                                                                                                          |
| `/risk-evidence`, `/risk-evidence/sites[/id]`, `/cases/[id]`, `/interventions` | insurer  | Consented evidence only: outcomes, recurrence, recommendations, package metadata                                                                                |
| `/trust`                                                                      | both     | How conclusions are reached, what a package proves, what is not claimed                                                                                         |

A reported action and a verified improvement are always shown as different facts. The insurer
screens say "Not shared with you" for any scope the customer did not grant, and revoking sharing
removes access on the insurer's next request. The earlier `/ui/*` pages in `apps/api` are
superseded; they remain as a fallback and debugging surface. Browser tests use the real backend on
a simulated clock through `scripts/s7-backend.ts`; the identity switcher lists
`GET /api/v1/dev/identities` (local only). The layout is responsive (tables become cards on
phones) and was checked with axe-core (WCAG 2.1 A/AA).

### Grounded explanations (S8)

Case detail (facility) and the shared case (insurer) show a **Plain-language summary** below the
deterministic facts. The explanation comes from the `ExplanationProvider` port in
`packages/ai-explanation`: a deterministic **template** (default, offline, always the fallback) or the
**Gemini** adapter (Vertex AI REST). Gemini only restates facts the deterministic system already
established; every answer is validated against those facts (schema, ids, numbers, result and level
fidelity, approved actions, prohibited claims) and one failed check discards it in favour of the
template. The page labels what it is: "AI-generated explanation based on verified system data" only for a
validated Gemini answer, otherwise "Template summary ... No AI model was used". Insurer explanations use
the consent-filtered projection only and are denied the moment sharing is revoked.

```
GET /api/v1/cases/:id/explanation          # facility (same authorization as the case)
GET /insurance/v1/cases/:id/explanation    # insurer (consent gateway, audited)
SYMBIOSIS_AI_PROVIDER=gemini GCP_PROJECT_ID=... VERTEX_ACCESS_TOKEN=... pnpm dev   # opt in; template otherwise
```

The model, region and limits are in `config/explanation/explanation.v1.json` (default model
`gemini-2.5-flash`, override with `GEMINI_MODEL`). See [docs/AI_GOVERNANCE.md](docs/AI_GOVERNANCE.md).

### Google Cloud runtime (S9)

The same services run in two adapter families selected by `SYMBIOSIS_RUNTIME`: `local` (in-memory,
demo identity header; unit tests, `pnpm dev`, the S2-S8 smokes) and `gcp` (Firestore, Pub/Sub,
Cloud Storage, Secret Manager, Firebase Authentication, Vertex AI through the service identity).
`gcp` refuses to start on missing configuration and never falls back to memory. Deployed as three
Cloud Run services (public `web` and `api`, **private** `worker`) with dedicated least-privilege
service accounts. Resource map, IAM matrix, Firestore structure, transaction boundaries, delivery
and dead-letter behavior, deployment and rollback: [docs/GCP_RUNTIME.md](docs/GCP_RUNTIME.md).

```
pnpm test                      # includes Firestore contract tests on the emulator (needs Java; see runbook)
pnpm seed:gcp --confirm-project <id>      # explicit, idempotent synthetic demo seeding (operator only)
SMOKE_S9=1 GCP_PROJECT_ID=<id> pnpm smoke:s9 --confirm-project <id>   # OPT-IN: touches the real project
```

Cloud sign-in uses Firebase Email/Password; the API verifies each ID token and derives organization,
facilities and roles from stored records, never from the request. Demo-user passwords are written only to
the git-ignored `.secrets/demo-users.json`.
