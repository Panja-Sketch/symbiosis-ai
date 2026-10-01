# Session Handoff

## Current phase

S8 — Gemini explanation layer (finished; S9 not started)

## Current phase status

COMPLETE

## Last completed phase

S8 — Gemini explanation layer (S0 to S7 completed earlier)

## Completed work

- **Explanation layer (`packages/ai-explanation`, D-064 to D-068, full detail in `docs/AI_GOVERNANCE.md`):** port `ExplanationProvider`; deterministic `TemplateExplanationProvider` (default, offline, fallback); `GeminiExplanationProvider` (Vertex AI `generateContent` over REST, no SDK, credential and network injected, the only file that knows the endpoint); `FakeGemini` scripted endpoint for tests, browser tests and smokes; `ExplanationService` (timeout, strict all-or-nothing validation, template fallback, cache keyed by a hash of the exact facts, governance log, never throws, never writes domain state).
- **Facts and grounding:** `buildFacilityContext` (facility `CaseView` + evidence metadata) and `buildInsurerContext` (consent-filtered projection only). Stable fact ids, real provenance (case, event, action, verification + policy version, intervention + policy version, package ids). Absent scopes become "not shared" limitations. No telemetry, keys, credentials or other tenants can reach a prompt (no input field exists for them). Fixed system prompt; operator notes are length-limited, control-stripped, JSON-encoded in a separate untrusted block with neutralized delimiters. Validator rejects: bad schema/extra keys, unknown fact ids, invented numbers or identifiers, `ACT-` ids outside the approved library, restating the result or level as another, resolution/premium/coverage/dispatch/legal/authorship claims, AI claiming authority.
- **Schema `explanation-output.v1`:** `summary`, `keyFacts`, `whyItMatters`, `actionContext`, `verificationExplanation`, `interventionExplanation`, `evidenceExplanation`, `limitations`, `sourceFactIds` (D-065 explains the deviation from the spec 18.1 example).
- **API:** `GET /api/v1/cases/:id/explanation` (same auth/tenancy as the case) and `GET /insurance/v1/cases/:id/explanation` (consent gateway on every request, audited, built from `gateway.caseView` + `interventions` only). Prompts are never returned.
- **UI:** `ExplanationPanel` streamed with Suspense after "Did it work?" (facility) and the verification section (insurer): "Authoritative system facts (deterministic)" box above a separate dashed explanation box; only a validated Gemini answer is labelled "AI-generated explanation based on verified system data"; the template says "No AI model was used"; a fallback names the reason; failure is a quiet notice. Deterministic sections never wait for it.
- **Config (D-067):** `config/explanation/explanation.v1.json`: provider default `template`, model `gemini-2.5-flash` (the spec names none; assumption to confirm before enabling in S9), env overrides `SYMBIOSIS_AI_PROVIDER`, `GEMINI_MODEL`, `GCP_PROJECT_ID`, `GCP_REGION`, `VERTEX_ACCESS_TOKEN` (placeholders only in `.env.example`).
- **Runtime/harness:** `createLocalRuntime` composes the service (`explanations`, `explanationLog`, option `explanationProvider`); `scripts/s7-backend.ts` gained `/control/ai` and `/control/ai-log`; `pnpm smoke:s8` added.
- Not implemented (by design): any S9 cloud work (no Cloud Run, service account, Firestore, Pub/Sub, Firebase, Secret Manager), AI portfolio summaries, client-side refresh, streaming tokens.

## Files changed

Commit `429451e` (`feat(s8): add grounded Gemini explanations`). New: `packages/ai-explanation/src/{types,phrases,facts,template,validate,prompt,gemini,fake-gemini,service,config,fixtures,explanation.test}.ts`, `config/explanation/explanation.v1.json`, `apps/web/src/components/{ExplanationPanel,ExplanationLoaders}.tsx`, `scripts/smoke-s8.ts`, `tests/integration/s8-{explanations,web}.test.ts(x)`, `tests/unit/ai-boundaries.test.ts`, `tests/e2e/explanations.spec.ts`, `docs/AI_GOVERNANCE.md` (written). Modified: `apps/api/src/{app-handler,insurance-handler}.ts`, `scripts/{local-runtime,s7-backend}.ts`, web `CaseDetail`, `InsurerCaseDetail`, the two case pages, `lib/{types,loaders}.ts`, `globals.css`, `tests/unit/web-boundary.test.ts`, `tests/e2e/helpers.ts`, package manifests/lockfile, `.env.example`, README, DECISIONS (D-064 to D-068), IMPLEMENTATION_STATE.

## Commands executed

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm test:e2e`, `pnpm smoke:s2` to `smoke:s8`, a mutation script (below), secret and cloud audits, `git status/diff/log`.

## Exact test results

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: exit 0.
- `pnpm test`: **61 test files, 895 tests, 895 passed, 0 failed** (S7 baseline 57 / 832). New: package unit tests 29, integration (real API) 18, web UI over real API 7, AI boundary tests 9.
- **E2E (Playwright): 26 passed, 0 failed** (the 17 S7 tests unchanged plus 9 for S8: AI label and facts-first, template default, four fallback modes, prompt injection, insurer consent and revocation, persona wording, phone layout, governance log, axe on AI and fallback panels for both personas).
- **Smoke: `smoke:s2` 9 PASS / 0 FAIL, `s3` 21 / 0, `s4` 31 / 0, `s5` 35 / 0, `s6` 32 / 0, `s7` 15 / 0, `s8` 17 / 0** (all exit 0).
- **Mutation checks (all detected, all restored; baseline 63/63 targeted tests after):** M1 AI output may contradict the verification result: 3 failed; M2 insurer explanation served without consent: 4; M3 full case JSON (telemetry-derived fields) sent to the model: 6; M4 malformed Gemini output trusted: 5; M5 a Gemini error fails the whole request: 6; M6 action outside the approved library allowed: 3.
- Audits: no cloud SDK, no credentials, no S9 resources (`infrastructure/` untouched); no domain package depends on `ai-explanation` or mentions Gemini (tests); the web app has no AI client; the explanation path is read-only (snapshot tests with the template, a good answer, a rejected answer and a quota failure).

## Known issues

- **Model id is an assumption** (`gemini-2.5-flash`, D-067): the spec names none; confirm availability/region before enabling in S9. The real Vertex endpoint has not been called (no credential in this environment); the adapter is exercised against a scripted endpoint only, so request-shape drift against the live API is untested.
- **Validation is conservative, not semantic:** it cannot prove a sentence true. Free-form Gemini prose that stays inside the facts, numbers and wording rules is accepted. A strict number rule may reject legitimate rephrasing (dates, spelled-out numbers) and fall back to the template; that is the safe direction.
- **Access token comes from an environment variable** (`VERTEX_ACCESS_TOKEN`), local only; S9 replaces it with workload identity / Secret Manager.
- **Cache and governance log are in-process** (lost on restart); S9 persistence. No client-side refresh button.
- The explanation page makes extra API calls per view (case, evidence, explanation); the facility case list is still N+1 (S7).
- S5/S6/S7 items still open (see earlier handoffs in git history): no package signature, `REVOKED` also means expired, consent per organization and facility, local identity, in-memory stores. TypeScript pinned `~6.0`; Windows `process.exit()` crash avoided via `process.exitCode`.

## Architectural decisions made

See `docs/DECISIONS.md` (D-001 to D-068; S8 is D-064 to D-068).

## Current git status

Clean after the S8 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

`429451ebc449387e442929d60c061e2f27f3bc29` (S8 implementation, `feat(s8): add grounded Gemini explanations`). Check `git log` for the later handoff commit, which changes only documentation.

## Exact next task

S9 — GCP adapters (PROJECT_SPEC sections 11.2, 12.1, 39 and Phase S9): Firestore repositories, Pub/Sub event bus, Cloud Storage evidence store, Secret Manager, Firebase Authentication, Cloud Run, each behind the existing ports (`EventBus`, repositories, `EvidenceObjectStore`, `ActorDirectory`, `ExplanationProvider`), with core tests still cloud-free. Do not start until explicitly instructed. Suggested first slice: the Firebase identity adapter (replacing the development identity cookie and `X-Demo-Actor-Id`), then Firestore repositories with a contract-test suite shared with the in-memory ones, then Secret Manager for the Vertex credential and a live Gemini smoke behind an explicit opt-in.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm exec playwright install chromium
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5 && pnpm smoke:s6 && pnpm smoke:s7 && pnpm smoke:s8
pnpm test:e2e
pnpm dev     # web http://127.0.0.1:3000, api http://127.0.0.1:8787 (template explanations by default)
```

## Cloud resources touched

None

## Secrets referenced (NAME ONLY)

None referenced in code. Placeholder names in `.env.example`: GCP_PROJECT_ID, GCP_REGION, FIREBASE_PROJECT_ID, DEVICE_KEY_SECRET_NAME, SMTP_SECRET_NAME, EVIDENCE_SIGNING_SECRET_NAME, EDGE_PORT, EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID, SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX, SIMULATOR_SCENARIO, OPS_TICK_INTERVAL_MS, and for S8 SYMBIOSIS_AI_PROVIDER, GEMINI_MODEL, VERTEX_ACCESS_TOKEN (all empty placeholders). The web app reads `SYMBIOSIS_API_URL` and `WEB_PORT`. No real credential exists in the repository.
