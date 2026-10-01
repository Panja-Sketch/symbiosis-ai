# Session Handoff

## Current phase

S9 — Google Cloud production adapters and deployment foundation (finished; S10 not started)

## Current phase status

COMPLETE

## Last completed phase

S9 — Google Cloud production adapters and deployment foundation (S0 to S8 completed earlier)

## Completed work

- **Runtime selection (D-069, D-070):** `adapters/gcp` (all cloud SDKs) and `packages/runtime` (config, shared composition, cloud platform, health, entrypoints). `SYMBIOSIS_RUNTIME=local|emulator|gcp`; `gcp` fails startup on any missing/invalid setting, refuses emulator hosts, demo identity and a static Vertex token, refuses to run on Cloud Run unless `gcp`, and verifies Firestore and the evidence bucket at boot. `scripts/local-runtime.ts` now uses the same `composeServices` as the cloud, so S2-S8 behavior is unchanged (all earlier smokes/E2E identical).
- **Identity (D-071):** `IdentityResolver` seam; Firebase ID token verified server-side (signature, issuer, audience, expiry, revocation) -> UID link -> stored actor (org, facilities, roles). No demo header, `/ui` pages or dev identity listing in the cloud. Web sign-in (HttpOnly session cookie, token refresh, sign-out) in `apps/web`; no persona switcher in the cloud. Four synthetic demo users (`pnpm seed:gcp`; passwords only in git-ignored `.secrets/demo-users.json`).
- **Firestore (D-072):** all repositories, audit log (per-organization gap-free sequence), actor/organization directories, device registry, replay guard, event inbox; tenant-prefixed ids; atomic uniqueness via `create()`/transactions; `storedAt` vs domain time. One shared contract suite runs on in-memory and the Firestore emulator (found and fixed a concurrency bug in the in-memory revoke).
- **Pub/Sub (D-073):** `PubSubBus` (publish rejects on failure), push consumer in the private worker with OIDC verification, event inbox for duplicates, retry 10-300 s, dead letter after 5 attempts, DLQ pull subscription, Scheduler tick every minute.
- **Cloud Storage (D-074):** `GcsEvidenceObjectStore` (never overwrites, read-back SHA check, key validation); bucket private. **Secret Manager (D-075):** device keys, fail closed. **Vertex (D-076):** ADC only; model corrected to `gemini-3.1-flash-lite` on the `global` endpoint after live testing; the cloud no longer lets the project region choose the Gemini location.
- **Cloud Run (D-077):** `symbiosis-web` (public), `symbiosis-api` (public, application-level auth), `symbiosis-worker` (private). Distroless non-root images by digest; `/livez`, `/readyz`, `/version`; structured redacted logs. Reproducible scripts in `infrastructure/` (`gcloud/01-identities-and-iam.sh`, `gcloud/02-deploy.sh`, `cloudbuild/cloudbuild.yaml`, `firestore/firestore.rules`, `firebase-web-config.json` (public config)). Runbook, IAM matrix, resource map: `docs/GCP_RUNTIME.md`.
- Not implemented (by design): any S10 hardware work, DLQ reprocessing, alert policies, mail delivery, cross-repository transactions.

## Files changed

Commits `4b4d55a` (adapters, runtime, web sign-in, builds, contract suite), `219efc1` (smoke, livez, provider error logging, scripts, docs), `3066a7e`/`43e248b` (docs state, smoke rerun handling), the Gemini-location fix commit, and the final handoff commit. New: `adapters/gcp/**`, `packages/runtime/**`, `tests/contract/**`, `tests/support/firestore-emulator.ts`, `scripts/{build-service.mjs,seed-gcp.ts,smoke-s9.ts,vertex-live.ts,mutation-s9.mjs}`, `Dockerfile.service`, `Dockerfile.web`, `.dockerignore`, `.gcloudignore`, `infrastructure/**`, web sign-in files, `docs/GCP_RUNTIME.md`. Modified: `apps/api` handlers (identity seam), `packages/tenancy` (resolver), `packages/repositories` (revoke atomicity), `packages/ai-explanation` (token supplier, global host, `GEMINI_LOCATION`), `config/explanation/explanation.v1.json` (model/location), `scripts/local-runtime.ts`, web lib/components, five boundary tests (D-069), README, `.env.example`, DECISIONS (D-069 to D-077).

## Commands executed

`pnpm install/lint/typecheck/test/format:check/test:e2e`, `pnpm smoke:s2` to `smoke:s8`, `pnpm seed:gcp`, `pnpm smoke:s9`, `node scripts/mutation-s9.mjs`, `scripts/vertex-live.ts`, `gcloud` (read-only reconnaissance; IAM, Pub/Sub, Scheduler, Secret Manager, Firestore index, Cloud Build, Cloud Run deploys), Firebase management REST (web app), Identity Toolkit sign-in REST for demo users.

## Exact test results

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: exit 0.
- `pnpm test` (with `SYMBIOSIS_REQUIRE_EMULATOR=1`): **64 test files, 965 tests, 965 passed, 0 failed** (S8 baseline 61 / 895). New: `tests/contract/repositories.contract.test.ts` 32 (16 in-memory + 16 Firestore emulator), `adapters/gcp/src/gcp.test.ts` 27, `packages/runtime/src/config.test.ts` 11. Five older boundary tests were updated, not skipped (D-069).
- **E2E (Playwright): 26 passed, 0 failed** (unchanged from S8; run before the last runtime-only commit).
- **Local smokes (all exit 0):** `smoke:s2` 9/0, `s3` 21/0, `s4` 31/0, `s5` 35/0, `s6` 32/0, `s7` 15/0, `s8` 17/0 (PASS/FAIL).
- **`pnpm smoke:s9` against the real project: 60 passed, 0 failed** (final run, after the last deploy): Firebase real-token verification, forged/unsigned/wrong-project rejected; Firestore write/read + tenant isolation; Pub/Sub publish, worker consumption and duplicate dropped (processed=1, dropped=1, from Cloud Logging); Cloud Storage write, SHA-256, no overwrite, bucket private with no public principal; Secret Manager read (value never shown) and per-secret IAM; live Vertex with the S8 validator; worker private; anonymous/forged/demo-header requests denied; authenticated customer succeeds; hero case end to end in real time (signed device -> Pub/Sub -> worker -> case -> alert -> ack -> action -> VERIFICATION PENDING -> verified by a deterministic tick -> immutable package with valid integrity reloaded from Cloud Storage -> Gemini explanation from Cloud Run via workload identity); insurer denied, consented, then denied again right after revocation. The run happened inside the recurrence watch of an earlier smoke case, so it also proved recurrence reopening the SAME case.
- **Mutation checks (all detected, all restored; script `scripts/mutation-s9.mjs`):** M1 GCP mode falls back to memory (1 failed), M2 token not verified (2), M3 organization from the request (1), M4 Firestore tenant filter removed (1, emulator), M5 evidence overwrite allowed (1), M6 duplicate processed twice (1), M7 secret value logged (survived at first: the test only used values the value-scrubber also catches; test strengthened, then 1 failed), M8 static AI token accepted (1), M9 storage failure treated as success (1), M10 insurer bypasses consent (3).
- **Dead-letter proof (live, manual):** a malformed message published to `symbiosis-events` was rejected by the worker 5 times (logged `push delivery malformed`, about 15-20 s apart) and then appeared in `symbiosis-events-dlq-pull`; nothing else was affected.
- **Incident found and fixed during the session:** the mutation script was run while a Cloud Build upload was starting, so one deployed revision (api/worker/web `-00002`) contained mutant M2. It was caught by the smoke (valid tokens suddenly unauthorized), replaced by a clean rebuild from a committed tree (`-00003`, then `-00004`), and never served a forged identity (the mutant mapped every token to a UID with no actor link). Rule: never run mutation checks while a build or deploy is being prepared.

## Deployed state

Region `us-central1`, project `symbiosis-ai-2026`. Final revisions and images (tag = commit SHA; deployed by digest):

| Service            | Revision                    | Image digest                                                                    |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- |
| `symbiosis-api`    | `symbiosis-api-00004-gdw`   | `sha256:d94f0b4b663e058cd67313a1ffb5e9accd03d1ec80e650df786f6b7e360e49cd`       |
| `symbiosis-web`    | `symbiosis-web-00004-mgk`   | `sha256:e59c2a28bbfe26b3032c59741479b675341dd50fcf80d751f7958ca237d734d7`       |
| `symbiosis-worker` | `symbiosis-worker-00004-86k`| `sha256:bf690595360b0414b11c0564d0f135da5db88fe52f933d304b447c445258e760`       |

URLs: API `https://symbiosis-api-554089078085.us-central1.run.app`, web `https://symbiosis-web-554089078085.us-central1.run.app`, worker (private, not invocable anonymously) `https://symbiosis-worker-554089078085.us-central1.run.app`. Identities, IAM matrix and the rest of the map: `docs/GCP_RUNTIME.md`. A synthetic hero case (`COOLING_ELECTRICAL_DETERIORATION on AST-SIM-FAN-A`), its verification, evidence package and audit entries exist in the demo tenant `ORG-SIM-001` as demo records.

## Known issues

- Services persist related records one after another (no cross-repository transaction); recovery is idempotent redelivery plus `tick()` repair (D-072).
- One worker instance, concurrency 1; Pub/Sub is unordered; DLQ has no reprocessing tool and no alert policy (Cloud Monitoring metrics/logs only; none created).
- Notifications are `ConsoleEmail` log lines. The cloud UI shows ids instead of names.
- The retirement schedule of `gemini-3.1-flash-lite` could not be confirmed from the documentation (D-076); the model is configurable and the template is the fallback.
- Broad pre-existing roles remain on the Compute default and `firebase-adminsdk` service accounts (not used by the services); the Firebase web API key has no referrer restriction. The Cloud Build upload tarball and logs live in the default buckets.
- Firestore contract tests need Java plus a Firestore emulator jar (found in the firebase-tools cache here); without it they skip loudly, and `SYMBIOSIS_REQUIRE_EMULATOR=1` turns that into a failure. No Pub/Sub emulator was available, so the Pub/Sub adapter is unit-tested with fakes and proven live by the smoke.
- Smoke part C writes a synthetic demo case and a revoked agreement document is deleted afterwards; audit entries remain (append-only).
- S5/S6/S7/S8 open items stay open (no package signature, `REVOKED` also means expired, consent per organization and facility, TypeScript pinned `~6.0`).

## Architectural decisions made

`docs/DECISIONS.md` (D-001 to D-077; S9 is D-069 to D-077).

## Current git status

Clean after the S9 handoff commit; `main` pushed to `origin/main`.

## Last known good commit SHA

See `git log`: the final S9 handoff commit (documentation only) sits on top of the Gemini-location fix commit, the last code change, which is what the deployed `-00004` revisions were built from.

## Exact next task

S10 — hardware integration (ESP32 firmware and provisioning against the unchanged signed `/edge/v1` protocol; PROJECT_SPEC section on hardware and Phase S10). Do not start until explicitly instructed. Suggested first slice: provision the real device record and a fresh device key in Secret Manager through an operator script (never the browser), point one real ESP32 at `https://symbiosis-api-554089078085.us-central1.run.app/edge/v1/telemetry`, and reuse `firmware-contracts/` known-answer vectors and the cloud smoke's device steps as the acceptance test. Remember the firmware must persist its sequence number across reboots (D-017).

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install && pnpm exec playwright install chromium
pnpm lint && pnpm typecheck && SYMBIOSIS_REQUIRE_EMULATOR=1 pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5 && pnpm smoke:s6 && pnpm smoke:s7 && pnpm smoke:s8
pnpm test:e2e
pnpm dev     # local mode: web http://127.0.0.1:3000, api http://127.0.0.1:8787
# cloud (opt-in, real project): see docs/GCP_RUNTIME.md
SMOKE_S9=1 GCP_PROJECT_ID=symbiosis-ai-2026 pnpm smoke:s9 --confirm-project symbiosis-ai-2026
```

## Cloud resources touched

Project `symbiosis-ai-2026`: created 5 service accounts (`symbiosis-web|api|worker|pubsub-push|scheduler`), project/topic/bucket/secret/service IAM bindings (see `docs/GCP_RUNTIME.md`), Pub/Sub subscriptions `symbiosis-events-worker` (push, DLQ policy) and `symbiosis-events-dlq-pull`, Cloud Scheduler job `symbiosis-tick`, one Firestore composite index, Secret Manager secret `symbiosis-device-key-DEV-SIM-001-KEY-SIM-001`, Firebase web app `Symbiosis web` (a duplicate created by mistake was removed), four Firebase Auth demo users, Firestore documents (seed + smoke data), three Cloud Run services, images in Artifact Registry `symbiosis`, Cloud Build jobs. Reused unchanged: Firestore database and its deny-all rules, evidence bucket, topics, Artifact Registry repository, Firebase project and Email/Password sign-in.

## Secrets referenced (NAME ONLY)

Secret Manager: `symbiosis-device-key-DEV-SIM-001-KEY-SIM-001`. Local git-ignored file `.secrets/demo-users.json` (demo-user passwords). Environment variable names: see `.env.example` (all empty placeholders). No credential, token or password is in the repository; the Firebase web config in `infrastructure/firebase-web-config.json` is public project configuration.
