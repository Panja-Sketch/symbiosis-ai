# Session Handoff

## Current phase

S7 — Persona UI (finished; S8 not started)

## Current phase status

COMPLETE

## Last completed phase

S7 — Persona UI (S0 to S6 completed earlier)

## Completed work

- **Next.js web app (`apps/web`, D-056):** Next 16.3 (App Router, Turbopack), React 19, plain responsive CSS, no UI framework. Server components fetch; Server Actions forward one command and redirect with a fixed notice or the API's own error; every control is a plain form. `pnpm dev` now also starts it on `:3000`; `pnpm web:build`, `pnpm test:e2e`, `pnpm smoke:s7` added.
- **API boundary (D-057):** the web app imports no `@symbiosis/*` package, repository or script (a boundary test enforces this, plus: no rule-like code, no clock use, no AI/cloud names, fetch only in `lib/api.ts`, insurer pages never call facility endpoints). It uses `/api/v1` for the facility persona and `/insurance/v1` for the insurer persona over HTTP, server side only. DTOs are web-owned (`lib/types.ts`) and a compile-time test checks the backend read models stay assignable to them.
- **Demo identity (D-058):** `HttpOnly` cookie with an actor id only; the API resolves it (`/api/v1/me`) from its server-side directory; "Demo identity" badge and "Local demo" banner; switcher fed by the new local-only `GET /api/v1/dev/identities`. Persona (navigation only) is derived from permissions; 403/`ACCESS_DENIED`/404 render as words.
- **Backend additions (D-059), the only domain-adjacent changes:** `GET /api/v1/dev/identities` and `CaseView.nextSteps {canAcknowledge, canAssignOrReport}` (state-only read projection sharing the workflow's own constants). No lifecycle, verification, consent, evidence or intervention rule changed.
- **Routes:** `/`, `/operations`, `/operations/cases/[id]`, `/operations/evidence`, `/risk-evidence`, `/risk-evidence/sites`, `/risk-evidence/sites/[id]`, `/risk-evidence/cases/[id]`, `/risk-evidence/interventions`, `/trust`. Navigation differs by persona (facility: Operations, Evidence & sharing, Trust; insurer: Risk Evidence, Sites, Interventions, Trust).
- **Case detail (D-060):** DETECT-to-MONITOR flow strip, next-step line, nine questions of spec 25 plus a timeline; "Reported complete" and "Verified improved" shown side by side; before/after bars (backend means, zero-based, no percentages); criteria, policy, completeness, telemetry confidence; reopened history; evidence panel with live SHA-256 check and synthetic label; plain-language sharing with grant/revoke, nine standard scopes pre-ticked and `RAW_TELEMETRY` only in a separate advanced section (never ticked, only for roles allowed to grant it). Operators see "Evidence is not available to your role".
- **Insurer workspace:** consent-filtered overview cards, sites, cases, interventions, case evidence; absent scopes shown as "Not shared with you"; four deterministic intervention levels with translated reason codes, evidence sufficiency, supporting record count and an always-present decision-support note (wording is "recommended", never dispatched/scheduled); no live telemetry; the UI never requests raw telemetry.
- **Responsive/accessibility:** semantic headings and landmarks, labelled controls, skip link, visible focus, status = icon + text, tables become cards under 760 px, no horizontal scroll at 1366/820/390 px (tested), axe-core WCAG 2.1 A/AA clean on every main screen.
- **Proof UI superseded (D-061):** the S4 to S6 `/ui/*` pages stay as a documented fallback, untouched and still tested.
- Not implemented (by design): Gemini/AI of any kind (S8), Firebase and cloud adapters (S9), dark mode, a full Trust Center beyond `/trust`, PDF export, package signing.

## Files changed

Commit `49aa94e` (`feat(s7): implement Symbiosis persona web experience`, 78 files). New: `apps/web` (config, `src/app/**` 10 routes + layout/error/loading/not-found/actions/globals.css, `src/components/**`, `src/lib/**`), `scripts/s7-backend.ts`, `scripts/smoke-s7.ts`, `playwright.config.ts`, `tests/e2e/*` (3 specs + helpers), `tests/integration/s7-web.test.tsx`, `s7-backend.test.ts`, `tests/unit/web-boundary.test.ts`, `web-contract.test.ts`, `apps/web/src/lib/lib.test.ts`. Modified: `apps/api/src/app-handler.ts` (dev identities), `packages/action-orchestration/src/{view,operations}.ts` (nextSteps, shared constants), `scripts/local-runtime.ts`, `scripts/dev.mjs`, `scripts/dev-runtime.ts` (hint), root `package.json`/lockfile, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, two S6 boundary tests (D-063), README, DECISIONS (D-056 to D-063), IMPLEMENTATION_STATE.

## Commands executed

`pnpm install`, `pnpm exec playwright install chromium`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm test:e2e`, `pnpm smoke:s2` to `smoke:s7`, `pnpm dev` (started and checked `:3000` and `:8787`), screenshots reviewed, `git status/diff/log`.

## Exact test results

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: exit 0.
- `pnpm test`: **57 test files, 832 tests, 832 passed, 0 failed** (S6 baseline 52 / 796). New: web integration over the real API 14, backend projections 3, web boundary 8, web DTO contract 3, web helpers 8. Three S6-era assertions were adapted (D-063).
- **E2E (Playwright, Chromium, production build against the real backend): 17 passed, 0 failed** (hero journey incl. identity switching, grant, insurer view, revoke; five verification outcomes incl. reopened; wrong-persona and cross-tenant denial; consent filtering; no-dispatch wording; axe on 9 screens; keyboard focus; no horizontal scroll at laptop, tablet and phone; phone case-detail flow). Run twice in a row, stable.
- **Smoke: `smoke:s2` 9 PASS / 0 FAIL, `s3` 21 / 0, `s4` 31 / 0, `s5` 35 / 0, `s6` 32 / 0, `s7` 15 / 0** (all exit 0).
- Audits: no Gemini, cloud SDK, Firebase or secrets; web code imports no domain package; only app dependencies added (next, react, react-dom, types; dev: Playwright, axe-core).

## Known issues

- **Case list is N+1 over HTTP** (one `GET /cases/:id` per case, server side). Fine for the demo; a list projection is the fix if portfolios grow.
- **Light theme only;** no dark mode. Dates are UTC.
- **Feedback after an action travels in the URL** (`?notice=` key from a fixed table, `?msg=` API error text shown as plain text). Harmless but not tamper-proof; a flash cookie or session store can replace it in S9.
- **Summary-card groupings** (e.g. unsuccessful outcomes count as "action required") are presentation choices documented in `lib/summary.ts` and D-060.
- **Operators and auditors cannot read evidence** (API permission); the UI says so. Sharing defaults tick all nine standard scopes; the user must still press the button.
- **No client-side live refresh:** pages show the state at load; there is no polling (by design).
- E2E depends on a locally installed Chromium (`pnpm exec playwright install chromium`) and ports 3100, 8791, 8792 (smoke uses 3101, 8793, 8794).
- S6/S5 items still open (see git history of this file): no package signature, `REVOKED` also means expired, consent per organization and facility, local-only identity/in-memory stores. TypeScript pinned `~6.0`; Windows `process.exit()` crash avoided via `process.exitCode`.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-063; S7 is D-056 to D-063).

## Current git status

Clean after the S7 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`49aa94e638e106ec82b9d293c99a6afa25ee88d3` (S7 implementation, `feat(s7): implement Symbiosis persona web experience`). Check `git log` for the later handoff commit, which changes only documentation.

## Exact next task

S8 — Gemini (PROJECT_SPEC section 21 and the AI governance rules in `docs/AI_GOVERNANCE.md`): explanation-only AI behind `packages/ai-explanation`, grounded in deterministic case facts, labelled as AI-generated, never in verification, lifecycle, severity or intervention-level selection, with a deterministic fallback when the model is absent. Do not start until explicitly instructed. Suggested first slice: the `ExplanationProvider` port with a deterministic template provider and the Gemini adapter behind it, a "plain-language summary" panel on case detail that reads only the existing `CaseView` and is clearly marked as generated, and tests that assert the AI output can never change a state.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm exec playwright install chromium
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5 && pnpm smoke:s6 && pnpm smoke:s7
pnpm test:e2e
pnpm dev     # web http://127.0.0.1:3000, api http://127.0.0.1:8787
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO, OPS_TICK_INTERVAL_MS. The web app reads `SYMBIOSIS_API_URL` (a URL, not a secret) and `WEB_PORT` (dev launcher). The cookie `symbiosis_demo_actor` holds a synthetic actor id only.
