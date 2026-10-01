# Symbiosis AI

A vendor-neutral, human-in-the-loop continuous risk **verification** platform for property
insurers and insured businesses. See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the locked
architecture (single source of truth).

## Status

Phases **S0** (foundation), **S1** (domain core), **S2** (local ingestion), **S3** (detection +
baselines), **S4** (operations workflow) and **S5** (verification + recurrence + intervention
prioritization) are complete. A simulated device is authenticated, normalized and assessed; a
deterministic rule detects persistent compound deterioration and opens a Risk Improvement Case; an
alert goes out through a local notification port (ConsoleEmail); a person acknowledges, an approved
action is assigned and reported, and the case waits as **VERIFICATION PENDING**. A reported action
is **never** evidence that the risk improved: a deterministic verification over trusted
post-action sensor readings (versioned policy in `config/verification-policy/`) concludes
`VERIFIED`, `PARTIALLY_VERIFIED`, `NOT_IMPROVING` or `INCONCLUSIVE`, history is kept, and if the
same hazard returns inside the recurrence-watch window the **same** case is `REOPENED`. A
deterministic, versioned risk-engineer intervention recommendation (decision support only) is
recalculated on material events. The system deliberately stops there: **no evidence package,
consent, final UI, AI or cloud integration yet.** Progress is tracked in
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

## Running locally (S2-S4)

```
pnpm dev          # api + worker (one process, in-memory bus) and the simulator
pnpm smoke:s2     # self-checking ingestion run over real HTTP, exits non-zero on failure
pnpm smoke:s3     # baseline -> isolated anomalies -> compound deterioration -> one case
pnpm smoke:s4     # detected -> alert -> acknowledge -> assign -> report -> VERIFICATION PENDING
pnpm smoke:s5     # ... -> trusted post-action data -> VERIFIED -> hazard returns -> same case REOPENED
```

`pnpm dev` listens on `http://127.0.0.1:8787` (override with `EDGE_PORT`) and prints each
telemetry event as the simulator's signed packets flow through. The **web app is not part of
`pnpm dev` yet** (Next.js arrives in S7); api and worker share a process only because the local
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
