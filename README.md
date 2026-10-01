# Symbiosis AI

A vendor-neutral, human-in-the-loop continuous risk **verification** platform for property
insurers and insured businesses. See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the locked
architecture (single source of truth).

## Status

Phases **S0** (repository foundation), **S1** (domain core) and **S2** (local ingestion) are
complete. A local simulator can send signed telemetry through the same edge endpoints future
hardware will use; the packet is authenticated, replay-checked, normalized into canonical
observations, quality-assessed and emitted as typed in-memory events. There is still **no risk
detection, baselines, case workflow, verification evaluation, UI or cloud integration**. Progress
is tracked in [docs/IMPLEMENTATION_STATE.md](docs/IMPLEMENTATION_STATE.md).

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

## Running locally (S2)

```
pnpm dev          # api + worker (one process, in-memory bus) and the simulator
pnpm smoke:s2     # self-checking end-to-end run over real HTTP, exits non-zero on failure
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
