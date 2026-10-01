# Architectural Decisions

Meaningful architectural/technical decisions only. `PROJECT_SPEC.md` is the architecture
source of truth; this log records choices made while implementing it. Not a session diary.

## D-001 — pnpm workspace monorepo (S0, 2026-09-30)

- **Decision:** pnpm workspaces over `apps/*`, `packages/*`, `adapters/*`, per spec §44.
- **Reason:** Spec mandates a pnpm monorepo with logical capabilities as packages.
- **Alternatives:** npm/yarn workspaces, Nx/Turborepo — rejected as unnecessary tooling (§11, §50.4).

## D-002 — Source-only packages, no build step in S0 (S0, 2026-09-30)

- **Decision:** Packages export TypeScript source (`main`/`types` → `src/index.ts`) with `moduleResolution: Bundler`. Type checking is one root `tsc --noEmit` over all workspace sources; each package also has a `tsconfig.json` extending `tsconfig.base.json`.
- **Reason:** Simplest setup that is compile-safe and resolves workspace deps. Build/bundling is revisited when deployables need it (S9).
- **Alternatives:** TS project references with per-package builds — deferred, no S0 value.

## D-003 — Strict TypeScript (S0, 2026-09-30)

- **Decision:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Reason:** Deterministic lifecycle/verification code benefits from the strictest typing from the start.

## D-004 — Tooling: TypeScript 6.0, ESLint 9, Vitest, Prettier (S0, 2026-09-30)

- **Decision:** ESLint 9 flat config + typescript-eslint; Vitest; Prettier + `.editorconfig`. TypeScript pinned to `~6.0`.
- **Reason:** typescript-eslint 8.71 supports TypeScript `<6.1`; the newest TypeScript (7.0) caused an unmet-peer warning. Revisit when typescript-eslint supports TypeScript 7.

## D-005 — Next.js deferred to S7 — sequencing only (S0, 2026-09-30)

- **Decision:** `apps/web` is a plain TypeScript placeholder in S0.
- **Reason:** Avoids heavy React/Next dependencies with no S0 value. This is **sequencing only**: the locked architecture (spec §11.1) still requires `apps/web` to become a Next.js app, scheduled for S7.

## D-006 — `pnpm dev` fails loudly in S0 (S0, 2026-09-30)

- **Decision:** `pnpm dev` runs a script that prints "NOT IMPLEMENTED" and exits non-zero.
- **Reason:** Spec §39 expects `pnpm dev` to run web/api/worker/simulator; no runtime exists until S2+, so a success exit could be mistaken for a working local app.

## D-007 — `packages/contracts` limited to generic primitives in S0 (S0, 2026-09-30)

- **Decision:** Only a `Brand` helper, `IsoTimestamp`, and four ID aliases (organization, facility, asset, device). No S1 domain types.
- **Reason:** The domain model (cases, events, actions, verification, lifecycle) belongs to S1.

## D-008 — Documentation stubs only (S0, 2026-09-30)

- **Decision:** `ARCHITECTURE.md`, `DOMAIN_MODEL.md`, `THREAT_MODEL.md`, `AI_GOVERNANCE.md`, `EVIDENCE_STANDARD.md`, `HARDWARE.md` and `docs/submission/README.md` are phase-labelled stubs pointing to the spec.
- **Reason:** Spec §44 lists them; `PROJECT_SPEC.md` must remain the single architecture source of truth, so nothing is duplicated.

## D-009 — No Co-Authored-By trailer on commits (S0, 2026-09-30)

- **Decision:** Commits in this repository carry no `Co-Authored-By` line.
- **Reason:** Explicit project-owner instruction.

## D-010 — Domain contracts use plain string IDs; time is passed explicitly (S1, 2026-09-30)

- **Decision:** Domain types use `string` for IDs exactly as written in the spec (the S0 branded `OrganizationId` etc. remain available but are not required). Every command carries an explicit `at` timestamp; domain code never reads the system clock, environment or network, and does not yet depend on the `clock` package.
- **Reason:** Spec types use plain strings, and branding would make every fixture and later adapter verbose with no S1 benefit. Explicit time keeps transitions deterministic. A boundary test (`tests/unit/domain-boundaries.test.ts`) enforces purity.

## D-011 — Shared Result / DomainError / TransitionRecord live in `contracts` (S1, 2026-09-30)

- **Decision:** Domain operations return `Result<T, DomainError>`; transitions return `{ value, record }` where `record` is a `TransitionRecord`. `DomainError.code` distinguishes illegal lifecycle/action/recommendation transitions, missing verification reference, verification mismatch, invalid recurrence, missing active event and timestamp regression.
- **Reason:** Every domain package needs the same vocabulary; putting it in `contracts` avoids cross-domain dependencies. The record is what the audit package will persist later (spec section 37) without the domain doing I/O.

## D-012 — Package split and dependency direction (S1, 2026-09-30)

- **Decision:** `risk-cases` owns the case aggregate and its state machine; `risk-lifecycle` owns the RiskEvent state machine plus cross-aggregate coordinators (`completeVerification`, `reopenOnRecurrence`, `grantsMitigationCredit`); `recommendations` and `action-orchestration` own their models; `verification` holds only the assessment validator. Graph: contracts <- verification <- {recommendations, risk-cases} <- risk-lifecycle; action-orchestration -> contracts. No cycles (tested).
- **Reason:** Keeps illegal transitions unreachable through each aggregate's public API while letting cross-aggregate invariants live in one place. `verification` exposes synthetic fixtures through a `@symbiosis/verification/testing` subpath so tests share one assessment fixture.

## D-013 — Spec gaps resolved for S1 (S1, 2026-09-30)

- **Decision:** The spec names but does not define `TimeWindow`, `CriterionResult`, the RiskEvent shape, or transition tables beyond the happy path. S1 defines: minimal `TimeWindow` and `CriterionResult`; `RiskEvent` with `latestVerificationId`; transition tables in `CASE_TRANSITIONS`, `RISK_EVENT_TRANSITIONS`, `RECOMMENDATION_TRANSITIONS` and `ACTION_TRANSITIONS`. Notable choices: outcome states (`PARTIALLY_VERIFIED`, `NOT_IMPROVING`, `INCONCLUSIVE`) can re-enter `ACTION_REPORTED` for another cycle; `VERIFIED` events are terminal (recurrence creates a new event); recurrence can reopen only from `VERIFIED_IMPROVED` (corrected after S1: `CLOSED` is terminal and is never eligible, since closure does not imply a verified improvement existed; spec 4.1/8.3); a case cannot be closed while `VERIFYING`; `MitigationAction.reportedBy/reportedAt` are optional and present only once `REPORTED_COMPLETE` (spec lists them as required, which cannot hold for a merely assigned action); an action may be reported complete without prior acknowledgement.
- **Reason:** Required to implement the state machines without inventing replacement concepts. Revisit if later phases need different paths; changes must be recorded here.

## D-014 — VERIFIED requires a self-consistent assessment (S1, 2026-09-30)

- **Decision:** `validateVerificationAssessment` rejects a `VERIFIED` result unless there is at least one required criterion, all required criteria passed, and at least one evidence ID; it also checks ranges, windows and required fields. Lifecycle code accepts a verification outcome only through a valid assessment whose case/event match.
- **Reason:** Principle 3 / section 8.1: a verified state must be unforgeable by a bare status change. This is structural validation only; threshold evaluation, windows and policy execution remain S5.
