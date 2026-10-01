# Session Handoff

## Current phase

S3 — Detection + baselines (finished; S4 not started)

## Current phase status

COMPLETE

## Last completed phase

S3 — Detection + baselines (S0, S1, S2 completed earlier)

## Completed work

- **Step 0, multi-asset mapping (D-023):** `DeviceRecord.assetMapping { byField, bySignal }` over a default `assetId`; resolved in `normalization.resolveAssetId`; carried in `telemetry.authenticated`. Synthetic device maps zone readings to `AST-SIM-ZONE-1`, outdoor temperature to `AST-SIM-OUTDOOR`, `chiller_b_running` to `AST-SIM-FAN-B`; vibration/current/load stay on `AST-SIM-FAN-A`. One-asset devices unchanged. `outdoor_temperature_c` added to the shared edge-v1 mapping.
- **`packages/baselines`:** config parsing, operating-mode resolution, `startBaseline`, `learn` (Welford), `zScore` (with stddev floor), `percentDeviation`, `rebaseline` (supersede + audit record). Statuses LEARNING / READY / INSUFFICIENT_DATA / SUPERSEDED (D-024, D-025).
- **`packages/risk-detection`:** rule config parsing and `evaluateSample` (pure): per-instant facts, baseline learning, hero rule, persistence, severity, per-observation evaluations and detections (D-026).
- **`packages/data-quality`:** `assessTrust` / `TrustPolicy`.
- **`packages/repositories`:** baseline (history, snapshots, audit), detection-state, case (correlation lookup) and risk-event interfaces with in-memory implementations.
- **`packages/risk-cases`:** `RECORD_DETECTION` command (state-neutral, severity only escalates). **`packages/risk-lifecycle`:** `openCaseFromDetection`, `caseMatchesDetection`, `isEpisodeActive` (D-027).
- **`packages/contracts`:** baseline, snapshot, audit, detection, evaluation, `DetectionState` types; events `risk.observation_evaluated.v1`, `risk.detected.v1`, `case.created.v1`, `case.updated.v1`; `BASELINE` domain entity.
- **`apps/worker/src/risk-pipeline.ts`:** `startRiskPipeline` wires `telemetry.quality_assessed` to evaluation, detection and case creation/update (D-028).
- **Config (versioned, `config/rules/`):** `baselines.v1.json`, `cooling-electrical.v1.json` (alongside `data-quality.v1.json`).
- **Simulator scenarios (`adapters/simulator/src/scenarios.ts`):** normal, isolated-vibration, isolated-current, context-only, compound-outdoor-heat, compound-rising-temperature; `SIMULATOR_SCENARIO` env in the CLI. All still go through signed, authenticated ingestion.
- **Scripts:** `pnpm smoke:s3` (new), `pnpm smoke:s2` updated; `pnpm dev` now logs risk/case events.
- Bug found by the S3 smoke and fixed with a regression test: a perfectly flat temperature series produced a slope of about -2e-29, so with `slope > 0` float noise could read as "rising"; slopes below 1e-9 degC/h are now zero.
- Not implemented (by design): alerts/notifications, acknowledgement, assignment, actions, escalation, verification, recurrence after verified improvement, evidence, consent, UI, AI, cloud, firmware.

## Files changed

Commit `33479de` (`feat(s3): implement baselines and deterministic risk detection`): 48 files, +4346/-50 (17 new, 31 modified). New sources: `packages/baselines`, `packages/risk-detection/src/{config,evaluate}.ts`, `packages/contracts/src/{baseline,risk}.ts`, `apps/worker/src/risk-pipeline.ts`, `adapters/simulator/src/scenarios.ts`, `scripts/smoke-s3.ts`, the two rule configs, and tests. Modified: contracts events/errors/edge, device-registry, normalization, data-quality, repositories, risk-cases, risk-lifecycle, api handler, worker, simulator CLI, local runtime, dev scripts, S2 tests/smoke (updated where S3 legitimately changed them), README, DECISIONS (D-023 to D-029), IMPLEMENTATION_STATE.
The follow-up docs commit updates only this file.

## Commands executed

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm vitest run --reporter=json` (counts), `pnpm smoke:s2`, `pnpm smoke:s3`, `pnpm dev` (several short runs incl. scenario env), mutation checks on the detector (inclusive threshold flipped to exclusive: 4 tests failed; single signal allowed to be a candidate: 21 failed; both restored), grep audits (cloud SDKs, AI references, secrets, 64-hex literals, S4 terms, hard-coded thresholds), dependency-graph listing, `git status/log`.

## Exact test results

- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0. `pnpm format:check`: clean.
- `pnpm test`: **27 test files, 409 tests, 409 passed, 0 failed.**
  - risk-detection 59; risk-cases 36 (+6 in detection.test.ts); edge-security authenticate 32; risk-lifecycle 31 (+5 in detection.test.ts); contracts edge 25; baselines 25; api edge-handler 16; edge-security signing 15; data-quality 15 (+10 trust); tests/integration/detection 13; repositories s3 13 (+5); worker risk-pipeline 13; recommendations 12; tests/integration/ingestion 11; normalization 11; tests/unit/domain-boundaries 10; worker telemetry 9; action-orchestration 8; tests/unit/workspace.smoke 7; tests/unit/ingestion-boundaries 7; event-bus 7; verification 6; clock 2.
- **`pnpm smoke:s2`: exit 0, 9 PASS, 0 FAIL.**
- **`pnpm smoke:s3`: exit 0, 21 PASS, 0 FAIL** (real HTTP, default config, simulated clock, no waiting): 25 normal samples (the default 120 s warm-up) → vibration/current/temperature/humidity baselines READY; healthy samples NORMAL, no case; isolated vibration and isolated current → WATCH, no `risk.detected`, no case; 3 persistent compound samples → exactly one `risk.detected`, exactly one case (OPEN, DETECTED_HAZARD, MODERATE, assets AST-SIM-FAN-A + AST-SIM-OUTDOOR), exactly one risk event (DETECTED); order `quality_assessed → observation_evaluated ×3 → risk.detected → case.created`; four more compound samples → still one case and one event, `case.updated` ×4; no S4+ events; no dead letters. Reason codes: VIBRATION_Z_AT_OR_ABOVE_THRESHOLD, CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD, OUTDOOR_HEAT_CONTEXT, PERSISTED_3_OF_3 (z = 8.5, current +12.2%, outdoor 107.6 F).
- Audits: no cloud SDK dependency/import; no AI references in S3 code; no secret patterns; the only 64-hex strings are the public synthetic signing vector; only `.env.example` tracked; no S4 terms except one comment; no hard-coded thresholds in detector source; dependency graph acyclic (also asserted by a test).

## Known issues

- **Recurrence is not handled (S5):** `isEpisodeActive`/`findActive` treat `VERIFIED_IMPROVED` as inactive, so a detection against a verified case would currently open a second case. S5 must intercept that match first (D-027).
- **`RECORD_DETECTION` extends the S1 aggregate** (the only S1 change in S3); detections against cases in `ACTION_REPORTED`, `VERIFYING` and other later states are published but not applied to the case until S4/S5 define behavior.
- **Episodes never end in S3:** no `SELF_RESOLVED`/closure logic; continued qualifying instants keep producing `risk.detected` + `case.updated`.
- **Backup equipment state** (`equipment_running` on `AST-SIM-FAN-B`) is stored as a fact but does not influence severity yet ("control availability", spec 15.2).
- **Timing assumptions:** primary signals must share one `observed_at` (a telemetry sample); out-of-order or late observations are ignored by baselines and may be ignored by persistence. Detector state is per (org, facility, rule) and is loaded/saved per event (fine in memory; revisit contention in S9).
- **Baseline learning from the first samples assumes a known-normal start** (operator responsibility). Re-baseline exists as a domain function with audit record but has no API/UI/authz yet.
- **Severity in the demo is MODERATE** because current rises +12.2% (HIGH needs z >= 4 and +15%); thresholds are config and should be tuned after hardware characterization (H4).
- Smoke scripts set `process.exitCode` (calling `process.exit()` while sockets close crashes Node on Windows).
- Carried over: TypeScript pinned `~6.0`; pnpm notes `eslint@9` deprecated; auth failures return specific codes; firmware must persist its sequence; event payloads camelCase vs wire snake_case.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-029).

## Current git status

Clean after the S3 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`33479de39e2b92e75da3106b44f1314ea5a593c0` (S3 implementation). Check `git log` for the later handoff commit.

## Exact next task

S4 — Operations workflow (PROJECT_SPEC section 45; sections 6, 7, 24.1, 25): alert request, acknowledgement (audited), action report, escalation, notifications (console email), and the case UI/API surface for the operations side, all on the S1 lifecycle and the S3 cases. Do not start until explicitly instructed. Suggested first slice: the `risk.alert_requested` event and a notifications port (`ConsoleEmail`), then acknowledgement/escalation using `applyRiskEventCommand` and the case state machine, keeping S5 verification out.

## Exact commands needed to resume

```
git status && git log --oneline -8
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO. The simulator's default key is the public synthetic dev key from `@symbiosis/device-registry`; no real device key exists in the repository.
