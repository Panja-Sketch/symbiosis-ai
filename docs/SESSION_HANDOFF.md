# Session Handoff

## Current phase

S6 — Evidence + consent (finished; S7 not started)

## Current phase status

COMPLETE

## Last completed phase

S6 — Evidence + consent (S0 to S5 completed earlier)

## Completed work

- **Evidence package (`packages/evidence`, D-047 to D-049):** every completed verification (all four results, faithfully) produces an immutable `evidence-package.v1` built by a pure builder from existing trusted records only: payload (spec-19 facts, no id or timestamp so the hash is a pure function of the records), hashed artifacts (the referenced observations, baselines, actions, audit entries, policy and device snapshot), a SHA-256 `evidence-manifest.v1` and `manifestSha256`. Canonical form `symbiosis-canonical-json.v1` (sorted keys, no whitespace, plain JSON only). `verifyEvidencePackage` recomputes everything from the package alone; `EvidenceService.load` also checks canonical bytes and the index record. A missing referenced record, device snapshot or completion audit entry fails explicitly (no package, no event). Stored through `EvidenceObjectStore` (in-memory; Cloud Storage is S9) and an `EvidencePackageRepository` index; neither can overwrite. Creation is idempotent per verification, retried by `tick()` (`createMissing`).
- **Snapshot fix:** the verification runner freezes the device facts it used onto the completed attempt (`deviceSnapshots`); `DEVICE:<id>` evidence now resolves to that copy (also in S5 `resolveEvidence`). Other mutable records are embedded as hashed snapshots, so later registry, case or event changes never rewrite a package.
- **Case linkage:** new documentation commands in `risk-cases` (`RECORD_EVIDENCE_PACKAGE`, `SET_SHARING_STATE`) that preserve state, severity, verification references and `updatedAt`; invariant: a sharing state other than `NOT_SHARED` requires `latestEvidencePackageId`.
- **Consent (`packages/consent`, D-050 to D-053):** `SharingAgreement` (spec shape plus `createdAt`/`revokedBy`/`revocationReason`), ten scopes (`INTERVENTION_RECOMMENDATION` added; `RAW_TELEMETRY` separate, off by default, granting needs `SHARING_GRANT_RAW_TELEMETRY`), pure deny-by-default `evaluateAccess`, `SharingService` (create, revoke, list, reconcile, package reaction), `InsuranceGateway` (six read paths), scope-filtered projections. Sharing state is derived (`NOT_SHARED`, `SHAREABLE`, `SHARED`, `REVOKED`; a package alone is never `SHARED`; `REVOKED` also covers expiry).
- **Events (`.v1`):** `evidence.package_created` (caused by `verification.completed`), `evidence.shareable`, `consent.granted`, `consent.revoked`, `evidence.shared`. Audit actions: `EVIDENCE_PACKAGE_CREATED/READ`, `SHARING_AGREEMENT_CREATED/REVOKED`, `EVIDENCE_SHARED`, `SHARING_STATE_CHANGED`, `INSURER_EVIDENCE_READ`, `INSURER_ACCESS_DENIED`.
- **API/UI (D-054):** `GET /api/v1/evidence/:id`, `POST /api/v1/sharing-agreements`, `POST /api/v1/sharing-agreements/:id/revoke` (+ `GET /api/v1/sharing-agreements[/:id]`); insurer `GET /insurance/v1/sites`, `/sites/:id/cases`, `/cases/:id`, `/cases/:id/evidence` (`?include=raw_telemetry`, `?package=`), `/recommendations`, `/interventions`. New synthetic organizations and insurer actors (`USR-RISK-ENGINEER-001`, `USR-UNDERWRITER-001`, `USR-OTHER-INSURER-RE-001`); permissions `EVIDENCE_READ`, `SHARING_MANAGE`, `SHARING_GRANT_RAW_TELEMETRY`, `INSURANCE_EVIDENCE_READ`. The case page shows the evidence package, live hash verification, source label, sharing state, grant and revoke forms; `/ui/insurer/cases[/:id]` shows only consented evidence.
- **Runtime:** `tick()` = alert retries, escalation, verification, `evidence.createMissing()`, `sharing.reconcileAll()`; `pnpm smoke:s6` added.
- Not implemented (by design): S7 persona workspaces, Trust Center, Gemini, Firebase/Firestore/Pub/Sub/Cloud Storage/Secret Manager/Cloud Run, firmware, PDF export, package signing.

## Files changed

Commit `422f915` (`feat(s6): implement evidence and consent sharing`): 59 files, +7984/-101. New: `packages/contracts/src/{evidence,consent}.ts`, `packages/evidence/src/{canonical,hash,store,builder,verify,service}.ts`, `packages/consent/src/{access,sharing,projection,gateway}.ts`, `apps/api/src/insurance-handler.ts`, `scripts/smoke-s6.ts`, `tests/integration/{evidence,consent,s6-world}`, `tests/unit/evidence-boundaries.test.ts`, package tests (evidence canonical, consent access and projection, repositories S6, risk-cases documentation, tenancy organizations), `docs/EVIDENCE_STANDARD.md` (written). Modified: contracts (events, audit actions, verification attempt snapshot), repositories (evidence index, agreements, share ledger), risk-cases, tenancy (organizations, insurer actors), authz, action-orchestration case view, verification runner (device snapshots), api handler/html/server/edge types, local and dev runtime, root package.json, README, DECISIONS (D-047 to D-055), IMPLEMENTATION_STATE, and the six earlier test assertions listed in D-055.

## Commands executed

`pnpm install --offline`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` (prettier --write once), `pnpm exec vitest run --reporter=json` (counts), `pnpm smoke:s2` to `smoke:s6`, a mutation script (below), grep audits (cloud SDK, Gemini, secrets, co-author trailers), `git status/log/diff`.

## Exact test results

- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0. `pnpm format:check`: clean.
- `pnpm test`: **52 test files, 796 tests, 796 passed, 0 failed** (S5 baseline 43 files / 666 tests). New: integration evidence 29, integration consent/insurer API/UI 25, evidence boundaries 16, consent access 20, consent projection 10, evidence canonical 11, repositories S6 8, risk-cases documentation 6, tenancy organizations 4, plus 1 added authz test.
- **Smoke: `smoke:s2` 9 PASS / 0 FAIL, `smoke:s3` 21 / 0, `smoke:s4` 31 / 0, `smoke:s5` 35 / 0, `smoke:s6` 32 / 0** (all exit 0). `smoke:s6` covers steps 1 to 18 of the brief. Event order: `verification.completed > evidence.package_created > evidence.shareable > consent.granted > evidence.shared > consent.revoked`.
- **Mutation checks (all detected, all restored; baseline 796/796 after):** M1 unresolved evidence ids allowed: 3 tests failed; M2 insurer read without consent: 22; M3 revoked consent keeps working: 9; M4 raw telemetry through an ordinary evidence scope: 2; M5 hashing ignores changed content: 21; M6 verify ignores a changed artifact hash: 1; M7 package upgrades the result: 5; M8 package alone marks SHARED: 2; M9 device snapshot not frozen: 41; M10 wrong recipient accepted: 2; M11 expired agreement stays active: 4; M12 unauditable read released (fail open): 1; M13 facility scope ignored: 1.
- Audits: no cloud SDK, Gemini, Firebase, secrets or S7 code (only an interface comment names Cloud Storage); only workspace dependencies added; dependency graph acyclic (asserted by test); insurer HTTP handler reaches data only through the consent gateway (asserted); no co-author trailers.

## Package hash behavior

Same trusted records plus the same injected clock and ids produce byte-identical packages and hashes (tested across two runs). Changing one value in the payload, an artifact snapshot, an artifact hash, the manifest, the package id or dropping an artifact fails `verifyEvidencePackage`; a fully recomputed forgery is caught by the stored index. A historical package still verifies after the device registry, the case and the risk events change.

## Consent and revocation proof

`smoke:s6` and `tests/integration/consent.test.ts`: before consent the insurer is denied; after a scoped grant exactly the granted sections appear (each scope releases only its own section); raw telemetry, another facility, another insurer organization, an expired or not-yet-effective agreement and a missing scope are denied; revocation denies the next read at the same instant on every endpoint (`AGREEMENT_REVOKED`), keeps the agreement, the package, the hashes and the audit history, and moves the case to `REVOKED`; a second revoke is a 409 and cannot change `revokedAt`; one revoked agreement does not affect another.

## Insurer-access proof

Every gateway method requires `INSURANCE_EVIDENCE_READ` and re-evaluates the stored agreements at the current time with the actor's own organization as recipient (asserted statically and by tests); responses for unknown, uncovered and other-tenant cases are identical; every allowed and denied read is audited with actor, agreements and scopes; if the audit write fails nothing is released; a package failing integrity verification is withheld (500).

## Known issues

- **No package signature:** hashes show change, not authorship; signing (`EVIDENCE_SIGNING_SECRET_NAME`) is later hardening. No PDF.
- **`REVOKED` also means "expired"**: the four-value vocabulary cannot distinguish; the stored state catches up on the next tick (reads are enforced immediately).
- **Packages are created on the bus cascade after verification:** a failure dead-letters and relies on the `tick()` retry (`createMissing`); an event-publish failure after the package is stored would not be redelivered (the in-memory bus cannot fail here; S9 needs an outbox or transaction).
- **Consent grants are per organization and facility** (no per-case or per-package consent, no insurer-side organization hierarchy, no invitation flow).
- **Insurer case facts are partly live:** `recommendation` and the current recurrence count come from the live case; everything else comes from the frozen package.
- **Pre-agreement packages are releasable** once an agreement is active (the window governs access time).
- Device snapshots exist only for attempts completed since S6; an older attempt without one cannot yield a package that cites a device (explicit failure).
- S5 items still open: verification starts on the scheduler tick, no retry-without-action, intervention triggers `recommendation.overdue`/`telemetry.quality_changed`/`device.health_changed` not wired, atomicity by ordering rather than a transaction.
- Local only: development identity, in-memory stores, `POST /ops/tick`, ConsoleEmail. Carried over: TypeScript pinned `~6.0`; Windows `process.exit()` crash avoided via `process.exitCode`.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-055; S6 is D-047 to D-055).

## Current git status

Clean after the S6 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`422f915956c1ae6bffdef500a7274928fa0fe7e3` (S6 implementation, `feat(s6): implement evidence and consent sharing`). Check `git log` for the later handoff commit, which changes only documentation.

## Exact next task

S7 — Persona UI (PROJECT_SPEC sections 24, 25, 45): Operations Workspace, Risk Evidence Workspace, portfolio view and Trust Center, as the real Next.js `apps/web` (D-005), consuming the existing application and insurance APIs and the case-detail evidence and sharing sections; no new domain logic. Do not start until explicitly instructed. Suggested first slice: the Next.js shell with the development-identity switcher and the Operations case-detail page (all spec-25 sections including Evidence and Sharing) over `/api/v1`, then the insurer evidence workspace over `/insurance/v1`.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5 && pnpm smoke:s6
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO, OPS_TICK_INTERVAL_MS. The simulator default key is the public synthetic dev key from `@symbiosis/device-registry`; local actor and organization ids are synthetic; no real device key, credential or email address exists in the repository.
