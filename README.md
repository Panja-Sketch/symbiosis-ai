# Symbiosis AI

A vendor-neutral, human-in-the-loop continuous risk **verification** platform for property
insurers and insured businesses. See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the locked
architecture (single source of truth).

## Status

Phases **S0** (foundation), **S1** (domain core), **S2** (local ingestion) and **S3**
(detection + baselines) are complete. A local simulator sends signed telemetry through the same
edge endpoints future hardware will use; it is authenticated, replay-checked, normalized into
canonical observations (a device may map readings to several logical assets), quality-assessed,
and fed to a deterministic baseline engine and the cooling/electrical risk rule. A persistent
compound deterioration creates one Risk Improvement Case and Risk Event. There is still **no
alerting or operations workflow, verification, evidence, consent, UI, AI or cloud integration**.
Progress is tracked in [docs/IMPLEMENTATION_STATE.md](docs/IMPLEMENTATION_STATE.md).

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

## Running locally (S2, S3)

```
pnpm dev          # api + worker (one process, in-memory bus) and the simulator
pnpm smoke:s2     # self-checking ingestion run over real HTTP, exits non-zero on failure
pnpm smoke:s3     # baseline -> isolated anomalies -> compound deterioration -> one case
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
