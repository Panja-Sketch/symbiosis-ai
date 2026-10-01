# Session Handoff

## Current phase

S4 — Operations workflow (finished; S5 not started)

## Current phase status

COMPLETE

## Last completed phase

S4 — Operations workflow (S0 to S3 completed earlier)

## Completed work

- **Alerting (`packages/notifications`):** `NotificationSender` port, `ConsoleEmail` (local; nothing is emailed), deterministic rule-based alert text, `createAlerting`/`startAlerting`. `case.created` requests the INITIAL alert; the event becomes `ALERTED` only when the channel returns SENT. Failures are stored, retried (config), and become `exhausted` (D-030, D-031).
- **Escalation (`packages/escalation`):** versioned policy (`config/escalation/escalation.v1.json`), `runEscalationTick` (pure over repositories + Clock). Unacknowledged `ALERTED` events escalate after the severity deadline; exhausted undelivered alerts escalate `DETECTED` events; separate ESCALATION alert to ORG_ADMIN (D-033).
- **Operations service (`packages/action-orchestration`):** `createOperations` for acknowledge case, assign action, acknowledge action, report action, dismiss, case view/list; approved action library (`config/action-library/cooling-actions.v1.json`, RECOMMEND_ONLY enforced at parse); all-or-nothing commands (D-034).
- **Identity/authz (`packages/tenancy`, `packages/authz`):** synthetic actor directory (org/facility scope from the server side), role→permission table. Development identity only (D-032).
- **Audit (`packages/audit`):** append-only in-memory log of material actions (no hash chain yet).
- **API/UI (`apps/api`):** `app-handler` (`/api/v1/me`, `cases`, `cases/:id`, `acknowledge`, `assignments`, `actions`, `actions/:id/acknowledge`, `dismiss`, `ops/tick`) and minimal server-rendered, script-free pages `/ui/cases`, `/ui/cases/:id` (workflow-proof, not the S7 UI). A router separates signed `/edge/*` traffic from `/api` and `/ui` (D-036).
- **Detections in workflow states (D-035):** `RECORD_DETECTION` legal in `ACTION_REPORTED`; every detection audited (`CASE_CREATED`, `DETECTION_RECORDED`); worker pipeline now needs an `AuditLog`.
- **S1 adjustment (D-033):** event table gained `DETECTED -> ESCALATED` (pinned by regression tests). `MitigationAction` gained optional metadata fields. `case.updated` payload generalized (`change`, `previousState`).
- **Events (all `.v1`):** `risk.alert_requested`, `notification.requested|sent|failed`, `risk.alerted`, `risk.acknowledged`, `risk.escalated`, `risk.dismissed`, `action.assigned|acknowledged|reported`.
- **Runtime:** `scripts/local-runtime.ts` wires everything; `runtime.tick()` = retries then escalation; `pnpm dev` runs a scheduler-stand-in tick (`OPS_TICK_INTERVAL_MS`) and logs the new events; `pnpm smoke:s4` added.
- Not implemented (by design): verification (any), recurrence, evidence, consent, intervention prioritization, Next.js/persona UI, Gemini, Firebase/Firestore/Pub/Sub/Cloud Scheduler/Storage, SMTP, firmware, equipment control.

## Files changed

Commit `6d1a3c0` (`feat(s4): implement operations risk workflow`): 65 files, +5926/-189. New: `packages/{audit,authz,tenancy,escalation,notifications}` sources and tests, `packages/action-orchestration/src/{actions,library,operations,view,world.fixture}.ts` (S1 code moved to `actions.ts`), `packages/contracts/src/operations.ts`, `apps/api/src/{app-handler,html}.ts`, `config/escalation/escalation.v1.json`, `config/action-library/cooling-actions.v1.json`, `scripts/smoke-s4.ts`, `tests/integration/operations.test.ts`, `tests/unit/operations-boundaries.test.ts`. Modified: contracts events/action, repositories (alerts, actions), risk-cases and risk-lifecycle (S1 adjustments), worker risk pipeline (audit), local runtime and dev scripts, S3-era tests/smokes that S4 legitimately changed, README, DECISIONS (D-030 to D-036), IMPLEMENTATION_STATE, `.env.example`.
The follow-up docs commit updates only this file.

## Commands executed

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm vitest run --reporter=json` (counts), `pnpm smoke:s2`, `pnpm smoke:s3`, `pnpm smoke:s4`, `pnpm dev` (live curl of UI, API, edge), three mutation checks (see below), grep audits (cloud SDKs, AI refs, secrets, 64-hex, S5 calls, email addresses), dependency-graph listing, `git status/log`.

## Exact test results

- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0. `pnpm format:check`: clean.
- `pnpm test`: **37 test files, 527 tests, 527 passed, 0 failed.** Largest: risk-detection 59, risk-cases 36 (+7), action-orchestration operations 35 (+10 library, +8 S1 actions), authenticate 32, risk-lifecycle 31 (+5 +4 escalation-path), contracts edge 25, baselines 25, notifications 17, integration operations 16, api edge-handler 16, escalation 13, tests/unit boundaries (domain 10, ingestion 7, operations 9), plus the S1–S3 suites; new small suites: tenancy 4, authz 4, audit 3.
- **`pnpm smoke:s2`: exit 0, 9 PASS. `pnpm smoke:s3`: exit 0, 21 PASS. `pnpm smoke:s4`: exit 0, 31 PASS, 0 FAIL.**
  - S4 smoke (real HTTP, simulated time): baseline → compound deterioration → exactly one case and one risk event → alert requested, ConsoleEmail printed, event ALERTED in order → facility manager acknowledges (event ACKNOWLEDGED, case OPEN, duplicate acknowledgement 409) → approved action assigned (201, case ACTION_REQUIRED, action ASSIGNED with library version; unapproved action 400) → assignee acknowledges → report (action REPORTED_COMPLETE, event ACTION_REPORTED, case ACTION_REPORTED) → case is not VERIFIED_IMPROVED, no verification id, no `verification.*` event, API and UI say VERIFICATION PENDING and never render the word VERIFIED → three more compound samples keep one case in ACTION_REPORTED → other-organization actor gets 404 → no dead letters. S4 event order: `risk.alert_requested > notification.requested > notification.sent > risk.alerted > risk.acknowledged > action.assigned > action.acknowledged > action.reported`. Audit: CASE_CREATED, ALERT_REQUESTED, ALERT_SENT, RISK_ALERTED, RISK_ACKNOWLEDGED, ACTION_ASSIGNED, ACTION_ACKNOWLEDGED, ACTION_REPORTED, DETECTION_RECORDED.
- Mutation checks: failed alert still marking ALERTED → 8 tests failed; removing facility scoping → 1 failed; escalating regardless of acknowledgement → no failure because the S1 state machine independently rejects `ACKNOWLEDGED -> ESCALATED` (defense in depth). All restored.
- Audits: no cloud SDK dependency/import (only two older comments name Firestore/PubSubBus); no AI references in S4 code; no secrets; only 64-hex strings are the public synthetic signing vector; only `.env.example` tracked; no email addresses; no verification calls in S4 code; dependency graph acyclic (asserted by a test).

## Alert / acknowledgement / action / escalation behavior

- Alert: INITIAL alert id `ALR-<riskEventId>-INITIAL`; recipient = first FACILITY_MANAGER of the facility; ALERTED only after SENT; failure → stays DETECTED, retry every 60 s up to 3 attempts, then exhausted and escalated by the tick.
- Acknowledgement: needs ALERTED or ESCALATED; changes only the event (audited, `risk.acknowledged`); duplicate → 409.
- Actions: assign (event ACKNOWLEDGED; OPEN→ACTION_REQUIRED, owner set), assignee-only acknowledgement, report (event ACKNOWLEDGED→ACTION_REPORTED, case →ACTION_REPORTED; also allowed for further actions while ACTION_REPORTED); duplicate report 409; actions must be in the approved library and apply to the hazard.
- Escalation: deadline from alert `sentAt` by case severity (MODERATE 900 s); acknowledged events never escalate; escalation alert goes to ORG_ADMIN; original alert untouched; physical severity unchanged.
- Continued detections: ACTION_REQUIRED and ACTION_REPORTED keep their state, no duplicate case, recorded and audited; VERIFYING and later untouched (S5).

## Known issues

- **Dismissal then flapping:** a dismissed case is CLOSED, so the next qualifying detection opens a new case. False-alarm suppression needs a later design (S5/S6).
- **Failed alert blocks acknowledgement until escalation:** an event still `DETECTED` cannot be acknowledged; it escalates only after all delivery attempts fail (about 2 minutes with the default policy), then can be acknowledged. A shorter path (acknowledge from the UI while delivery is failing) was deliberately not added.
- **Event timestamps for workflow commands** use `max(clock, entity.updatedAt)` so device-clock skew cannot cause regressions; times in audit and events are therefore not strictly wall-clock.
- **Ownership:** the case owner is set only when an action is assigned (or reported); the alert recipient is recorded on the alert, not as case owner.
- **S5 must intercept:** recurrence (a detection against `VERIFIED_IMPROVED`, still opens a second case per D-027), `NOT_IMPROVING`/`INCONCLUSIVE` handling of detections during ACTION_REPORTED, and when `VERIFYING` starts.
- **Local only:** development identity header, in-memory repositories/audit/replay state, `POST /api/v1/ops/tick`, ConsoleEmail. The S4 pages are not the final UI.
- Detection-continued `case.updated` events are emitted on every qualifying instant (noisy but auditable).
- Carried over: TypeScript pinned `~6.0`; pnpm notes `eslint@9` deprecated; specific edge auth error codes; firmware must persist its sequence; Windows `process.exit()` crash avoided via `process.exitCode`.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-036).

## Current git status

Clean after the S4 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`6d1a3c0ea59e63ee2a50d23076d5356f35645681` (S4 implementation). Check `git log` for the later handoff commit.

## Exact next task

S5 — Verification + recurrence + intervention prioritization (PROJECT_SPEC section 45; sections 8, 16, 23A, 35 stages 5-7 and 10): versioned verification policy in `config/verification-policy/`, verification windows and the deterministic policy engine, INCONCLUSIVE behavior for missing or untrusted data, evidence IDs, `verification.started`/`verification.completed`, recurrence monitoring and reopening, and risk-engineer intervention prioritization (`config/intervention-policy/`). Do not start until explicitly instructed. Suggested first slice: the verification-policy config and a pure engine over canonical observations that consumes the S3 baselines, then the `ACTION_REPORTED -> VERIFYING` trigger in `action-orchestration`/`risk-lifecycle`, keeping the S4 view's `VERIFICATION PENDING` label until a result exists.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO, OPS_TICK_INTERVAL_MS. The simulator's default key is the public synthetic dev key from `@symbiosis/device-registry`; the local actor IDs are synthetic; no real device key, credential or email address exists in the repository.
