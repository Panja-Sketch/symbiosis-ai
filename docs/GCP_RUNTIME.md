# Google Cloud runtime and runbook (S9)

`PROJECT_SPEC.md` is the architecture; `docs/DECISIONS.md` D-069 to D-077 record the S9 choices. This
file is the operating manual for the deployed runtime. It contains names only, never secret values.

## Resource map (project `symbiosis-ai-2026`, region `us-central1`)

Found already present (reused, not recreated): Artifact Registry `symbiosis` (Docker), Firestore
Native `(default)` (deny-all rules), private bucket `symbiosis-ai-2026-evidence` (public access
prevention enforced, uniform access), Pub/Sub topics `symbiosis-events` and `symbiosis-events-dlq`,
Firebase attached with Email/Password enabled, Cloud Build / Cloud Run / Scheduler / Secret Manager /
Vertex AI APIs enabled. Absent at the start of S9 (created by S9): all runtime service accounts,
every subscription, every secret, the Scheduler job, the Firebase web app, the Firestore index,
every Cloud Run service.

| Resource                                             | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Cloud Run `symbiosis-web` (public)                   | Next.js UI, Firebase sign-in, forwards the user's ID token           |
| Cloud Run `symbiosis-api` (public, app-level auth)   | `/api/v1`, `/insurance/v1`, signed device `/edge/v1`, Vertex explanations |
| Cloud Run `symbiosis-worker` (**private**)           | Pub/Sub push consumer (`/pubsub/push`), Scheduler tick (`/tick`)      |
| Pub/Sub `symbiosis-events` / `symbiosis-events-worker` | Event bus; push subscription with retry and dead-letter policy      |
| Pub/Sub `symbiosis-events-dlq` / `-dlq-pull`         | Dead letters (5 failed deliveries), 7-day pull subscription           |
| Cloud Scheduler `symbiosis-tick` (every minute)      | Alert retries, escalation, verification, evidence repair, sharing    |
| Firestore `(default)`                                | All records (see structure), one composite index                      |
| Bucket `symbiosis-ai-2026-evidence`                  | Immutable evidence packages `evidence/<org>/<packageId>.json`         |
| Secret `symbiosis-device-key-<deviceId>-<keyId>`     | Device HMAC keys (demo: `DEV-SIM-001` / `KEY-SIM-001`)                |
| Firebase Auth                                        | Email/Password users (4 synthetic demo identities)                    |

## Runtime selection

| Mode       | Selected by                         | Adapters                                                                     |
| ---------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `local`    | default off Cloud Run               | in-memory everything, demo identity header (S2-S8 tests, smokes, `pnpm dev`) |
| `emulator` | `SYMBIOSIS_RUNTIME=emulator`        | Firestore emulator; other adapters in memory (tests only)                    |
| `gcp`      | `SYMBIOSIS_RUNTIME=gcp` (required on Cloud Run) | Firestore, Pub/Sub, Cloud Storage, Secret Manager, Firebase Auth, Vertex via ADC |

`gcp` refuses to start when a setting is missing or invalid, when an emulator host or static Vertex
token is present, or when the read-only startup checks (Firestore, evidence bucket) fail. It never
falls back to memory. Environment variables: `GCP_PROJECT_ID`, `GCP_REGION`,
`SYMBIOSIS_EVENTS_TOPIC`, `SYMBIOSIS_EVIDENCE_BUCKET`, `FIREBASE_PROJECT_ID`; worker also
`SYMBIOSIS_WORKER_AUDIENCE`, `SYMBIOSIS_PUSH_SERVICE_ACCOUNT`, `SYMBIOSIS_SCHEDULER_SERVICE_ACCOUNT`;
optional `SYMBIOSIS_AI_PROVIDER`, `GEMINI_MODEL`, `GEMINI_LOCATION`, `SYMBIOSIS_CHECK_REVOKED`,
`SYMBIOSIS_COLLECTION_PREFIX`. Web: `SYMBIOSIS_API_URL`, `SYMBIOSIS_AUTH_MODE=token`, build-time
`NEXT_PUBLIC_FIREBASE_*` (public web config).

## Identity mapping

Browser signs in with Firebase Email/Password, the web server stores the ID token in an HttpOnly cookie
after the API verified it, and forwards it as `Authorization: Bearer`. The API verifies it with the
Firebase Admin SDK (signature, issuer, audience, expiry, revocation) and maps
`identityLinks/{uid}` -> `actors/{actorId}` (organization, facility scope, roles). Nothing the client
sends can change that mapping. Demo users (created by `pnpm seed:gcp`, passwords in the git-ignored
`.secrets/demo-users.json`):

| Email (synthetic, `.example` domain)            | Actor                   | Organization | Persona                |
| ----------------------------------------------- | ----------------------- | ------------ | ---------------------- |
| `facility.manager@symbiosis-demo.example`       | `USR-FACILITY-MGR-001`  | `ORG-SIM-001` | facility manager       |
| `org.admin@symbiosis-demo.example`              | `USR-ORG-ADMIN-001`     | `ORG-SIM-001` | organization admin     |
| `risk.engineer@symbiosis-demo.example`          | `USR-RISK-ENGINEER-001` | `ORG-INS-001` | insurer / risk engineer |
| `other.org.manager@symbiosis-demo.example`      | `USR-OTHER-ORG-MGR-001` | `ORG-SIM-002` | isolation check        |

## Firestore structure

Collections (document id; query fields; every document also has `json` = the exact domain record and
`storedAt` = infrastructure time): `observations` (hash of device+signal+observedAt), `baselines`,
`baselineSnapshots`, `baselineAudit`, `detectionStates`, `cases`, `riskEvents`, `alerts`, `actions`,
`verifications`, `interventions`, `evidencePackages`, `evidencePackageByVerification` (uniqueness
anchor), `sharingAgreements` (agreement id), `sharedEvidence`, `auditEntries`, `auditCounters`,
`actors`, `organizations`, `identityLinks`, `devices` (no key material), `replayState`,
`processedEvents` (event inbox). Tenant-owned ids are `<organizationId>~<recordId>`. Required
composite index: `observations (organizationId, facilityId, observedAtMs)`. Rules: deny all.

### Transaction boundaries

| Operation                                   | Mechanism                                                   |
| ------------------------------------------- | ----------------------------------------------------------- |
| Observation dedupe                          | `create()` (atomic already-exists)                          |
| One evidence package per verification      | transaction over package + per-verification anchor          |
| Completed verification immutable            | transaction (read status, then write)                       |
| Revoke a sharing agreement once            | transaction                                                 |
| Audit sequence                              | transaction on a per-organization counter + entry           |
| Replay nonce / sequence                     | transaction on the device+key document                      |
| Shared-evidence record per agreement+package | `create()`                                                  |
| Case + event + audit + event publish        | **separate writes** (as in S0-S8); recovered by idempotent redelivery and `tick()` |

## Delivery, DLQ and operations

Pub/Sub delivers at least once and unordered. The worker (1 instance, concurrency 1) acknowledges only
after every handler succeeded and the event was recorded in `processedEvents`; a redelivered finished
event is dropped (log message `duplicate delivery dropped`). Failures answer 5xx: retry with backoff
10 s to 300 s, then dead letter after 5 attempts. Inspect dead letters:

```
gcloud pubsub subscriptions pull symbiosis-events-dlq-pull --project symbiosis-ai-2026 --limit 10
```

(no `--auto-ack`: pulled messages stay available until their ack deadline passes). Fix the cause, then
republish the message body to `symbiosis-events` (handlers are idempotent). Logs are structured JSON in
Cloud Logging with `component`, `eventId`, `eventType`, `correlationId`, `organizationId`, `caseId`
where relevant; credentials, tokens and key-like strings are redacted. Useful filter:
`resource.type="cloud_run_revision" AND jsonPayload.component="worker" AND severity>=ERROR`.

## Storage object naming

`evidence/<organizationId>/<packageId>.json` (ids from the system, never user input; validated).
Written once with `ifGenerationMatch: 0`, read back and hash-checked. No ACLs, no public access.

## Service accounts and IAM matrix (no Owner/Editor on any runtime identity)

| Identity (`@symbiosis-ai-2026.iam.gserviceaccount.com`) | Roles                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `symbiosis-api`                                         | `datastore.user`, `aiplatform.user`, `firebaseauth.viewer` (project); `pubsub.publisher` on `symbiosis-events`; `storage.objectViewer` on the evidence bucket; `secretmanager.secretAccessor` on device-key secrets only |
| `symbiosis-worker`                                      | `datastore.user` (project); `pubsub.publisher` on `symbiosis-events`; `storage.objectCreator` + `storage.objectViewer` on the evidence bucket |
| `symbiosis-web`                                         | none (logs only); calls the public API with the user's own token                             |
| `symbiosis-pubsub-push`                                 | `run.invoker` on `symbiosis-worker`                                                         |
| `symbiosis-scheduler`                                   | `run.invoker` on `symbiosis-worker`                                                         |
| Pub/Sub service agent                                   | `pubsub.publisher` on `symbiosis-events-dlq`, `pubsub.subscriber` on `symbiosis-events-worker`, `iam.serviceAccountTokenCreator` on `symbiosis-pubsub-push` |

Pre-existing, not created by S9 and not used by the services: the project owner user, the Compute
default service account and the `firebase-adminsdk` service account (both hold broad roles from
project creation; see Known limitations).

## Deployment procedure

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`, commit.
2. Build: `gcloud builds submit --config infrastructure/cloudbuild/cloudbuild.yaml --substitutions=_SHA=<12-char commit>,_WEB_API_KEY=<public web api key>,_WEB_APP_ID=<web app id>`
   (public web config is in `infrastructure/firebase-web-config.json`).
3. First time only: `bash infrastructure/gcloud/01-identities-and-iam.sh`, create the Firestore index (see
   map), `GCP_PROJECT_ID=... pnpm seed:gcp --confirm-project ...`.
4. Deploy: `bash infrastructure/gcloud/02-deploy.sh <12-char commit>` (worker, subscription, DLQ,
   Scheduler, API, web; by image digest).
5. Verify: `SMOKE_S9=1 GCP_PROJECT_ID=... pnpm smoke:s9 --confirm-project ...`.

## Rollback

Each deploy creates a new Cloud Run revision. Roll back one service with
`gcloud run services update-traffic symbiosis-<service> --region us-central1 --to-revisions <previous-revision>=100`
(find revisions with `gcloud run revisions list --service symbiosis-<service> --region us-central1`).
Data is not rolled back: records are append-only or idempotent and a new revision reads the same
Firestore. To stop processing without losing events, pause the push subscription
(`gcloud pubsub subscriptions modify-push-config symbiosis-events-worker --push-endpoint=""` turns it
into pull; restore the endpoint afterwards) or pause `symbiosis-tick`.

## Local versus cloud

`pnpm dev` and every S2-S8 smoke/test use `local`. Firestore contract tests use the Firestore emulator
(Java; started by Vitest global setup from `FIRESTORE_EMULATOR_JAR` or the firebase-tools cache;
`SYMBIOSIS_REQUIRE_EMULATOR=1` makes a missing emulator a failure instead of a skip). The only code that
touches the real project is opt-in: `pnpm seed:gcp`, `pnpm smoke:s9`, `scripts/vertex-live.ts`.

## Known limitations (S9)

- The services persist related records one after another (no cross-repository transaction); recovery is
  idempotent redelivery and `tick()` repair.
- One worker instance, concurrency 1: correct but low throughput; Pub/Sub ordering is not used.
- No DLQ reprocessing tool or UI; alerting on DLQ depth is not configured (Cloud Monitoring metrics and
  logs are available; no alert policies were created).
- Notifications are `ConsoleEmail` (structured log lines); no mail delivery exists.
- The cloud UI shows ids instead of names for people and organizations.
- The retirement schedule of the selected Gemini model was not independently confirmed (D-076).
- The Compute default service account and `firebase-adminsdk` service account still carry broad
  project roles from project creation; the Firebase web API key is unrestricted by referrer.
- The audit log has no hash chain; per-organization sequence contention limits sustained write rate.

## Physical device provisioning (S10)

`pnpm provision:device` (operator, ADC) creates the secret `symbiosis-device-key-<deviceId>-<keyId>`
(automatic replication, `secretAccessor` for `symbiosis-api@` only) and the Firestore `devices/<id>`
record (atomic create; duplicate ids refused). Rotation (`--rotate-key` with a new key id) is the
recovery path for a sequence error. Registered so far: `DEV-PHX-BENCH-001` (key id
`KEY-PHX-BENCH-001`, organization `ORG-SIM-001`, facility `FAC-SIM-001`), health `UNKNOWN` until its
first heartbeat. No Cloud Run revision changed in S10. To remove a device: delete the Firestore
document `devices/<id>` and the secret (all versions).
