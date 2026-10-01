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

## D-015 — Local edge API on `node:http`, transport-neutral handler (S2, 2026-09-30)

- **Decision:** `apps/api` exposes `createEdgeHandler(deps)`, a pure `(EdgeRequest) => EdgeResponse` function over raw body bytes, plus a thin `node:http` wrapper (`createEdgeServer`). No web framework was added.
- **Reason:** The signature covers the original bytes, so nothing may parse and re-serialize JSON first; `node:http` hands over the raw buffer with zero dependencies. Because the handler is transport-neutral, the Cloud Run deployment (S9) can reuse it unchanged. Bodies over 64 KiB get 413.
- **Alternatives:** Fastify/Express — rejected: extra dependency, body-parser hooks that risk altering raw bytes.

## D-016 — Edge signing format details left open by the spec (S2, 2026-09-30)

- **Decision:** The signed material is exactly the six spec lines joined by LF (no trailing newline). Choices the spec did not fix: `X-Timestamp` is Unix epoch seconds (decimal), `X-Seq` a non-negative decimal integer with no leading zeros, `X-Nonce` 16-64 chars of `[A-Za-z0-9_-]`, signature lowercase hex of HMAC-SHA256 (hex input accepted case-insensitively). PATH is the path alone; requests with a query string are rejected (400) because a query would be unsigned. Defaults: timestamps older than 300 s are stale, more than 60 s ahead are rejected. `firmware-contracts/sample-packets/signing-vector.json` is a known-answer vector computed independently (Python `hmac`) so firmware can reproduce it byte for byte.
- **Reason:** Epoch seconds avoid ISO formatting ambiguity on a microcontroller; canonical integer forms remove signing ambiguities.

## D-017 — Replay protection behind an atomic interface; recorded only after the signature verifies (S2, 2026-09-30)

- **Decision:** `ReplayGuard.checkAndRecord` atomically enforces per device+key: nonce uniqueness within a retention window and a strictly increasing `seq` (gaps allowed; reuse and rollback rejected). It is called only after HMAC verification, so unauthenticated traffic cannot burn nonces or advance sequences. `InMemoryReplayGuard` is local-only; a shared store can replace it in S9. Telemetry and heartbeat share one counter per device/key.
- **Reason:** Atomicity avoids check/record races; ordering prevents a denial-of-service on a legitimate device. Firmware must therefore persist its sequence (or seed it from trusted time) across reboots. This is HTTP request replay protection, distinct from observation dedupe.

## D-018 — Device registry holds no secrets; unknown health is not healthy (S2, 2026-09-30)

- **Decision:** `DeviceRegistry` (identity, org/facility/asset, status, active key ID, expected signals, firmware, last-seen, health) is separate from `DeviceKeyStore` (raw 32-byte keys), so Secret Manager can back the latter. Only `activeKeyId` is accepted. Health starts `UNKNOWN` and becomes concrete only through a heartbeat; `UNKNOWN` is treated as not healthy. The spec does not define a heartbeat payload, so S2 defines `{device_id, firmware_version, sent_at, health}`. The fixture device `DEV-SIM-001` and its key (the repeating pattern `0123456789abcdef` x4) are public, obviously synthetic, and grant nothing; no real ESP32 key exists in the repository.
- **Reason:** Principle 3 (missing data never becomes trusted) and secrets-out-of-Git.

## D-019 — S2 event flow and bus semantics (S2, 2026-09-30)

- **Decision:** `api` emits `telemetry.received` and `telemetry.authenticated` only for requests that passed authentication and schema validation (so unauthenticated traffic cannot flood the bus); `worker` emits `telemetry.normalized` then `telemetry.quality_assessed`, each caused by the previous event under one correlation ID. Payloads use camelCase; envelopes follow the spec (snake_case). `normalized` carries observations without quality; `quality_assessed` carries full `CanonicalObservation`s plus per-observation reason codes; duplicates are dropped (and counted) before either is emitted via `ObservationRepository.insertIfAbsent` on `device + signal + observedAt`. `EventBus` is `publish`/`subscribe` by event type; `InMemoryBus` delivers in order, queues events published from handlers, records history, and dead-letters handler failures. Event IDs come from an injectable `IdGenerator`. Time comes from the `clock` package.
- **Reason:** Keeps the flow deterministic and testable, and keeps a future `PubSubBus` drop-in. The domain packages from S1 still take explicit timestamps.

## D-020 — One shared edge-v1 mapping for hardware and simulator (S2, 2026-09-30)

- **Decision:** `normalization` owns `createEdgeV1Adapter`; `adapters/esp32` and `adapters/simulator` are thin instances differing only by adapter name and source type, so equivalent packets normalize identically (spec principle 16). Mapped fields: `temperature_c`→temperature (degC), `relative_humidity_pct`→relative_humidity (%), `vibration_rms_ms2`→vibration_rms (m/s2), `current_ma`→current (converted to A), `fan_a_load_pct`→load_percent (%), `chiller_b_running`→equipment_running. Unmapped fields, type mismatches and signals the device does not declare are reported as rejected readings, never silently dropped. `observed_at` is canonicalized to UTC ISO with milliseconds so equal instants share one dedupe identity. Known limitation: every reading is attributed to the device's single asset; separate assets for backup equipment (Fan B) need a later registry extension.
- **Reason:** Principle 16 and "no failure silently becomes success".

## D-021 — Plausibility thresholds in config; quality factors (S2, 2026-09-30)

- **Decision:** Physical plausibility ranges, staleness window and confidence factors live in `config/rules/data-quality.v1.json`, parsed and validated by `data-quality`; the file is loaded by the composition root, not by the package. Confidence is 1, halved when stale, halved when the device is not healthy, and 0 when out of range, observed in the future, or unauthenticated.
- **Reason:** Spec 50.10 (thresholds in versioned config). Deterministic, no baselines or statistics (S3).

## D-022 — Local runtime composition, `tsx`, and `pnpm dev` (S2, 2026-09-30)

- **Decision:** `scripts/local-runtime.ts` is the local composition root (the root package depends on the workspace packages it wires). `pnpm dev` (`scripts/dev.mjs`) starts api+worker as one process (they share the in-memory bus; separate Cloud Run deployables in S9) and the simulator as a separate process talking over HTTP. `web` is NOT started (Next.js arrives in S7); the launcher says so. `tsx` was added as a devDependency to run TypeScript sources (Node's type stripping cannot resolve our extensionless imports), and pnpm 12 required explicitly approving esbuild's install script (`allowBuilds` in `pnpm-workspace.yaml`). `pnpm smoke:s2` runs a real-HTTP smoke test against the runtime.
- **Reason:** Spec section 39 asks for `pnpm dev` to run web, api, worker and simulator; this is the honest S2 subset. The locked four-deployable architecture is unchanged.
