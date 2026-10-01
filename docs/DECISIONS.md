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
