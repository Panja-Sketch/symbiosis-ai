# Session Handoff

## Current phase

S2 — Local ingestion (finished; S3 not started)

## Current phase status

COMPLETE

## Last completed phase

S2 — Local ingestion (S0 and S1 completed earlier; S1 recurrence corrected in `7878f0e`)

## Completed work

- **S1 correction (`7878f0e`):** recurrence reopens only from `VERIFIED_IMPROVED`; `CLOSED` is terminal and never eligible (spec 4.1/8.3). D-013 corrected.
- **Contracts:** `CanonicalObservation`, canonical signal vocabulary, source types, quality, `UnassessedObservation`, dedupe key, edge telemetry/heartbeat DTOs with hand-written validators, event envelope and the four S2 event types (`PlatformEvent` union).
- **edge-security:** signing material/HMAC (`signing.ts`), timing-safe verification, `authenticateEdgeRequest`, `ReplayGuard` interface + `InMemoryReplayGuard`, typed `EdgeAuthFailure` codes.
- **device-registry:** `DeviceRecord`, `DeviceRegistry` / `DeviceKeyStore` interfaces, in-memory implementations, synthetic fixture `DEV-SIM-001`.
- **normalization / adapters:** one shared edge-v1 mapping; `adapters/esp32` and `adapters/simulator` are thin instances. The simulator adapter also contains `SimulatorClient` (builds, signs and sends real HTTP requests).
- **data-quality:** deterministic assessor + config parser; thresholds in `config/rules/data-quality.v1.json`.
- **event-bus:** `EventBus`, `InMemoryBus`, `IdGenerator`s, `createEnvelope`. **repositories:** `ObservationRepository` (+ in-memory, dedupe). **clock:** `Clock`, `SystemClock`, `ManualClock`.
- **apps/api:** transport-neutral `createEdgeHandler` + `node:http` wrapper; `POST /edge/v1/telemetry` and `/heartbeat`. **apps/worker:** telemetry pipeline. **apps/simulator:** CLI.
- **Local runtime:** `scripts/local-runtime.ts` (composition root), `pnpm dev` (`scripts/dev.mjs`: api+worker process + simulator; web not started), `pnpm smoke:s2`.
- **firmware-contracts/sample-packets:** telemetry/heartbeat samples and an independently computed signing known-answer vector (synthetic key).
- Decisions D-015 to D-022 recorded. README documents local run.
- Not implemented (by design): baselines, hero rule, `vibration_z`, current deviation, case creation from telemetry, risk events, escalation, workflow, verification evaluation, recurrence monitoring, evidence, consent, UI, any cloud/AI/firmware.

## Files changed

Commit `b2d60c1` (`feat(s2): implement signed local telemetry ingestion`): 64 files, +4262/-51. New/changed sources in `packages/{contracts,clock,device-registry,edge-security,normalization,data-quality,event-bus,repositories}`, `adapters/{esp32,simulator}`, `apps/{api,worker,simulator}`, `scripts/{local-runtime,dev-runtime,smoke-s2}.ts` and `scripts/dev.mjs` (replaces `dev-not-implemented.mjs`), `config/rules/data-quality.v1.json`, `firmware-contracts/sample-packets/*`, tests in each package plus `tests/integration/ingestion.test.ts` and `tests/unit/ingestion-boundaries.test.ts`, `package.json` (workspace devDependencies, `tsx`, scripts), `pnpm-workspace.yaml` (`allowBuilds: esbuild`), `tsconfig.json`, `.gitattributes`, `.prettierignore`, `.env.example`, README, DECISIONS, IMPLEMENTATION_STATE.
The follow-up docs commit updates only this file.

## Commands executed

`pnpm install`, `pnpm approve-builds esbuild`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm vitest run --reporter=json` (counts), `pnpm smoke:s2`, `pnpm dev` (9 s, then terminated), mutation checks (disabled signature check, disabled nonce check: tests failed as expected, then restored), grep scans (64-hex literals, secret patterns, tracked env files), dependency-graph listing, `git status`, `git log`.

## Exact test results

- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0. `pnpm format:check`: clean.
- `pnpm test`: **19 test files, 260 tests, 260 passed, 0 failed.**
  - `packages/edge-security/src/authenticate.test.ts` 32; `packages/risk-cases/src/risk-cases.test.ts` 36; `packages/risk-lifecycle/src/risk-lifecycle.test.ts` 31; `packages/contracts/src/edge.test.ts` 25; `apps/api/src/edge-handler.test.ts` 16; `packages/edge-security/src/signing.test.ts` 15; `packages/data-quality/src/data-quality.test.ts` 15; `packages/recommendations/src/recommendations.test.ts` 12; `tests/integration/ingestion.test.ts` 10; `tests/unit/domain-boundaries.test.ts` 10; `apps/worker/src/worker.test.ts` 9; `packages/action-orchestration/src/action-orchestration.test.ts` 8; `packages/event-bus/src/event-bus.test.ts` 7; `packages/normalization/src/normalization.test.ts` 7; `tests/unit/ingestion-boundaries.test.ts` 7; `tests/unit/workspace.smoke.test.ts` 7; `packages/verification/src/verification.test.ts` 6; `packages/repositories/src/repositories.test.ts` 5; `packages/clock/src/clock.test.ts` 2.
- **Smoke test (`pnpm smoke:s2`, real HTTP, system clock): exit 0, all checks PASS** — heartbeat 200; valid signed packet 202; six canonical observations (equipment_running, current 0.312 A, load_percent, relative_humidity, temperature, vibration_rms) with confidence 1, healthy, authenticated; events exactly `telemetry.received.v1 → authenticated → normalized → quality_assessed` with an unbroken causation chain and one correlation ID; no `risk.*` events; replay of the same packet rejected (409 NONCE_REPLAY); tampered payload rejected (401 SIGNATURE_MISMATCH); rejected requests created no observations or events.
- **`pnpm dev` run:** api+worker listened on the configured port, the simulator sent heartbeat=200 / telemetry=202 every interval, all four events logged per packet, clean shutdown, port freed.
- Scans: no cloud SDK dependency or import; no secret patterns; the only 64-hex strings are the public synthetic key and hashes/signature in `signing-vector.json`; only `.env.example` is a tracked env file; no S3 logic; dependency graph acyclic.

## Known issues

- **Windows:** calling `process.exit()` while sockets close triggers a libuv assertion; scripts set `process.exitCode` instead.
- **Spec gaps I filled (D-016, D-018, D-020):** timestamp/seq/nonce formats, heartbeat payload, `UNKNOWN` health default, single-asset-per-device mapping (Fan B/backup equipment needs a registry extension before S3/S5 rely on per-asset `equipment_running`). Confirm or adjust before firmware work (S10).
- Firmware must keep its sequence monotonic across reboots (persist it or seed from trusted time); a device restart that resets `seq` is rejected by design.
- Auth failures return specific codes over HTTP (helpful for bring-up, enumerates device existence); production may want to collapse these in S9/S11.
- `api` and `worker` share one process locally only because the bus is in-memory; `web` is not started by `pnpm dev` until S7.
- TypeScript pinned to `~6.0`; pnpm notes `eslint@9` as deprecated (D-004). pnpm 12 required `allowBuilds: esbuild` for `tsx`.
- Event payloads are camelCase while envelopes/edge DTOs are snake_case (spec-driven).
- Per-package `typecheck`/`test` scripts do not exist; everything runs from the repo root.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-022).

## Current git status

Clean after the S2 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`b2d60c1cbcd33b01ea2a6b11e4b5a7b8e6745c13` (S2 implementation). Check `git log` for the later handoff commit.

## Exact next task

S3 — Detection + baselines (PROJECT_SPEC section 45; sections 15, 17): baseline engine (warm-up window, per asset + signal + operating mode, audited re-baseline), hero compound rule from versioned config in `config/rules/`, case/event creation from detection using the S1 domain, tests. Do not start until explicitly instructed. Suggested first slice: baseline engine + `risk.observation_evaluated` event contract, consuming `telemetry.quality_assessed.v1`.

## Exact commands needed to resume

```
git status && git log --oneline -8
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX. The simulator's default key is the public synthetic dev key from `@symbiosis/device-registry`; no real device key exists in the repository.
