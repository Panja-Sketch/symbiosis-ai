# Session Handoff

## Current phase

S5 — Verification + recurrence + intervention prioritization (finished; S6 not started)

## Current phase status

COMPLETE

## Last completed phase

S5 — Verification + recurrence + intervention prioritization (S0 to S4 completed earlier)

## Completed work

- **Verification policy and engine (`packages/verification`, `config/verification-policy/cooling-electrical.v1.json`):** versioned hero policy (D-037) parsed fail-closed; `evaluateVerification` is a pure deterministic engine over scoped canonical observations, learned baselines (same operating mode only), device facts and the reported actions. Criteria: VIBRATION and CURRENT (required, sustained interval + hysteresis band), BACKUP_CAPACITY (required only when a reported action is on the policy list; must be observed running), ZONE_TEMPERATURE_SLOPE (role configurable, SUPPORTING by default), DATA_QUALITY and DEVICE_INTEGRITY (required). Results, precedence, completeness and confidence: D-039 to D-041.
- **Verification runner (`apps/worker/src/verification-runner.ts`):** the only code that starts or completes a verification (enforced by a test). `tick()` starts verification for `ACTION_REPORTED` cases (`verification.started`, case/event `VERIFYING`) and completes attempts whose window ended (`verification.completed`, case/event outcome) through the `risk-lifecycle` coordinators `startVerification`/`completeVerification` so state cannot partially persist. Processing failure becomes INCONCLUSIVE; a coordinator/repository failure leaves the attempt IN_PROGRESS and is reported. `resolveEvidence` proves evidence ids exist.
- **Verification attempts (`VerificationRepository`):** one immutable record per case/event/action cycle (policy id/version, actions, window, required signals, assessment, typed evidence references, `recurrenceWatchEndsAt`); history is never overwritten.
- **Recurrence (`packages/recurrence`, `apps/worker/src/risk-pipeline.ts`):** a qualifying detection against a `VERIFIED_IMPROVED` case of the same organization, facility, hazard and primary asset inside the watch window reopens the same case (REOPENED, `recurrenceCount + 1`, new RiskEvent, `recurrence.detected` then `case.reopened`, INITIAL alert for the new event); outside the window a new case opens (D-043). `RECORD_DETECTION` is now legal in `VERIFYING` and the unsuccessful outcome states.
- **Human follow-up (D-044):** assign/report accepted from PARTIALLY_VERIFIED, NOT_IMPROVING and INCONCLUSIVE; not silently closed.
- **Intervention prioritization (`packages/intervention-prioritization`, `config/intervention-policy/risk-engineer-prioritization.v1.json`):** rule policy over trusted facts, highest matching level wins, four allowed levels, supersede/resolve/acknowledge, event-driven recalculation (D-045). Decision support only.
- **API/UI:** `GET /api/v1/verifications/:id`, `GET /api/v1/interventions`, `GET /api/v1/interventions/:id`, `POST /api/v1/interventions/:id/acknowledge`; case view and minimal page gained "Did it work?" (pending or result, criteria, before/after, completeness, confidence, evidence-reference count), "Is it staying fixed?" and "Intervention recommendation".
- **Events (all `.v1`):** `verification.started`, `verification.completed`, `recurrence.detected`, `case.reopened`, `intervention.recommendation_updated`. Not emitted: any `evidence.*` (S6).
- **Runtime:** `runtime.tick()` = alert retries, escalation, then verification start/evaluation; `pnpm smoke:s5` added; simulator scenarios `partial-improvement` and `backup-running`.
- Not implemented (by design): evidence package/manifest/hash/PDF, consent, sharing, insurer evidence API, final UI, Gemini, Firebase/Firestore/Pub/Sub/Storage/Scheduler/Secret Manager/Cloud Run, firmware.

## Files changed

Commit `61c5296` (`feat(s5): implement physical verification and recurrence`): 61 files, +6877/-249. New: `packages/verification/src/{engine,policy,labels}.ts` (+ tests/fixture), `packages/recurrence/src/index.ts`, `packages/intervention-prioritization/src/{policy,engine,service}.ts`, `packages/contracts/src/intervention.ts`, `apps/worker/src/verification-runner.ts`, `config/verification-policy/cooling-electrical.v1.json`, `config/intervention-policy/risk-engineer-prioritization.v1.json`, `scripts/smoke-s5.ts`, `tests/integration/verification.test.ts`, `tests/unit/verification-boundaries.test.ts`. Modified: contracts (verification types, events, audit actions), repositories, risk-cases (`RECORD_DETECTION` states), risk-lifecycle (`startVerification`), operations service and case view, notifications alerting (`case.reopened`), authz, device-registry (`listForFacility`), api handler and page, worker pipeline, local runtime, dev runtime, simulator scenarios, root package.json, README, DECISIONS (D-037 to D-046), IMPLEMENTATION_STATE, earlier tests/smoke adjusted per D-046.

## Commands executed

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm exec vitest run --reporter=json` (counts), `pnpm smoke:s2` to `smoke:s5`, a mutation script (below), grep audits (cloud SDK, AI, secrets, S6 vocabulary, co-author trailers), `git status/log/diff`.

## Exact test results

- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0. `pnpm format:check`: clean.
- `pnpm test`: **43 test files, 666 tests, 666 passed, 0 failed** (S4 baseline was 37 files / 527 tests). New or notable: verification engine 63 (+6 validator), recurrence 10, intervention-prioritization 25, risk-lifecycle verification-flow 8, S5 integration 20 (V1 to V5, negatives, history, backup, API/tenancy), `verification-boundaries` 11, authz +1.
- **Smoke: `smoke:s2` 9 PASS / 0 FAIL, `smoke:s3` 21 / 0, `smoke:s4` 31 / 0, `smoke:s5` 35 / 0** (all exit 0). `smoke:s5` covers steps 1 to 23 of the brief plus the negative paths (no telemetry, unhealthy device, abnormal evidence). Event order in the verified-then-recurrence run: `action.reported > verification.started > verification.completed > intervention.recommendation_updated > recurrence.detected > case.reopened > intervention.recommendation_updated`.
- **Mutation checks (all detected, all restored):** (1) precedence bug letting insufficient required criteria through: 8 tests failed, but note it was initially NOT detected because the engine's validator backstop masked it, so a test now asserts the primary logic independently; with both layers broken (M1b) 27 failed; (2) action report may verify directly (ACTION_REPORTED to VERIFIED_IMPROVED in the case table): 4 failed; (3) authentication quality ignored: 3 failed; (4) missing required evidence turned into a pass: 2 failed; (5) recurrence creating a duplicate case instead of reopening: 2 failed.
- Audits: no cloud SDK, Gemini or secrets in new code (only guard tests and older comments name them); no S6 vocabulary outside the guard test; dependency graph acyclic (asserted by test); no co-author trailers.

## Recurrence proof

`smoke:s5` and `tests/integration/verification.test.ts`: after VERIFIED_IMPROVED, 12 normal samples keep the case verified; one isolated abnormal signal does not reopen; three persistent compound instants inside the 1 h watch window produce `recurrence.detected`, the same case id in REOPENED with `recurrenceCount` 1, a second RiskEvent (the first stays VERIFIED), one case total, an INITIAL alert for the new event, the prior verification untouched, and the intervention rising to RISK_ENGINEER_REVIEW. After 2 h the same hazard opens a second case instead.

## Known issues

- **Verification starts on the scheduler tick**, not immediately on `action.reported` (D-038). Without a tick nothing starts; `pnpm dev` ticks every `OPS_TICK_INTERVAL_MS` (10 s).
- **No retry-without-action:** an INCONCLUSIVE case needs another reported action to verify again; the domain table allows `INCONCLUSIVE -> VERIFYING` but no command exists. Re-alerting a failed cycle (demo stage 5) is not implemented.
- **Second action during `VERIFYING` is rejected** (409), and the window is not restarted.
- **Asset bindings in policy:** backup and zone-temperature asset ids are in the verification policy (no asset-topology model yet).
- **Evidence `DEVICE:<id>` is a live registry reference**, not a frozen health snapshot (S6 snapshots). Observation evidence includes excluded observations that explain an exclusion.
- **Intervention triggers not wired:** `recommendation.overdue`, `telemetry.quality_changed`, `device.health_changed` do not exist as events yet. Insurer-side roles cannot read recommendations until S6 sharing.
- **A VERIFIED_IMPROVED case with no verified record** (corrupt data only) would not match recurrence and a detection would open a new case.
- **Dismissal then flapping** (S4) is unchanged.
- **Atomicity** across repositories is by ordering (compute first, persist after), not a transaction; the in-memory stores cannot fail partway. A real store needs transactions (S9).
- Local only: development identity, in-memory stores, `POST /ops/tick`, ConsoleEmail. Carried over: TypeScript pinned `~6.0`; Windows `process.exit()` crash avoided via `process.exitCode`.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-046; S5 is D-037 to D-046).

## Current git status

Clean after the S5 handoff commit; `main` pushed to `origin/main`. The follow-up docs commit updates only this file.

## Last known good commit SHA

`61c5296b635cedf755ab1af9801e226ab176c85b` (S5 implementation, `feat(s5): implement physical verification and recurrence`). Check `git log` for the later handoff commit.

## Exact next task

S6 — Evidence + consent (PROJECT_SPEC sections 19, 20, 35 stages 8 to 9, 45): immutable evidence package and manifest built from the existing evidence references (`VerificationAttempt.evidenceReferences`, `resolveEvidence`), consent gateway, sharing agreements, insurer evidence API (spec 43) and the `evidence.*` / `consent.*` events. Do not start until explicitly instructed. Suggested first slice: an evidence-package builder that consumes a completed `VERIFIED` attempt, snapshots each referenced record (including device health at verification time) with a SHA-256 manifest, stored through a repository interface, emitting `evidence.package_created` and setting `latestEvidencePackageId`, before any consent or sharing.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO, OPS_TICK_INTERVAL_MS. The simulator default key is the public synthetic dev key from `@symbiosis/device-registry`; local actor ids are synthetic; no real device key, credential or email address exists in the repository.
