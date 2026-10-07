# Evidence Standard

This file records the concrete formats and rules the evidence and consent features use (see
`docs/ARCHITECTURE.md` for where they sit in the system). Decisions are numbered in `DECISIONS.md` (D-047 to D-055).

## What an evidence package is

An immutable, machine-readable record of one completed verification: the facts the deterministic
verification used and concluded, copied from trusted stores, with SHA-256 hashes. It is
documentation. It never creates a measurement, changes a verification result, a risk state or a
case state, and it preserves the actual result: a `NOT_IMPROVING`, `PARTIALLY_VERIFIED` or
`INCONCLUSIVE` package says so. **A package does not show improvement unless its result is
`VERIFIED`, and it is not shared with anyone until a sharing agreement releases it.**

Created for every completed verification (D-047), by `packages/evidence`, from the facts in the
`VerificationAttempt` and the records it references. If any referenced record cannot be resolved
the build fails explicitly (no package, no event).

## Structure (`evidence-package.v1`)

```
EvidencePackage
  packageId, schemaVersion, organizationId, facilityId, caseId, verificationId, createdAt
  payload                       facts only; NO package id, NO timestamp (hash is a pure function of the records)
    caseIdentity, recommendation (origin, source, approved actions), riskEvent (+ detection reason codes),
    reportedActions, acknowledgement | null, baselineWindow, postActionWindow,
    requiredCriteria, supportingCriteria, quality (completeness, telemetry confidence, device/auth status),
    verification (result exactly as recorded, confidence, reason codes, policy id/version, evaluatedAt),
    recurrence (count, watch end, prior verification ids), versions (policy, schema, canonicalization, hash, builder),
    evidenceReferences [{id, kind, sha256}], auditReferences [...], source (data-origin label)
  artifacts [{id, kind, snapshot, sha256}]   the referenced records, frozen as plain JSON
  manifest                      evidence-manifest.v1 (below)
  manifestSha256                SHA-256 of the canonical manifest
```

Artifact kinds are the S5 evidence kinds: `OBSERVATION`, `BASELINE`, `ACTION`, `AUDIT`, `POLICY`,
`DEVICE`. Values the sources do not contain are absent or `null` (for example `acknowledgement`),
never defaulted or guessed.

## Canonical serialization (`symbiosis-canonical-json.v1`)

The same value always produces the same bytes, whatever the insertion order, locale or timezone.

- UTF-8, no whitespace between tokens.
- Object keys sorted by UTF-16 code unit order (default string sort), recursively; properties whose
  value is `undefined` are omitted as if absent.
- Arrays keep their order; an `undefined` array element is an error.
- Strings use standard JSON escaping. Numbers must be finite and use the ECMAScript shortest
  round-trip form; `-0` is written `0`.
- Only plain JSON is accepted. `Date`, `Map`, `Set`, `bigint`, `symbol`, functions, class instances,
  `NaN`, `Infinity` and cycles are rejected, never coerced.
- Timestamps are ISO-8601 UTC strings treated as ordinary strings, so no timezone participates.
- Hash = lower-case hex SHA-256 of the UTF-8 bytes. The object store keeps the canonical bytes.

## Manifest and hashes (`evidence-manifest.v1`)

```
manifestSchema, hashAlgorithm ("SHA-256"), canonicalization, packageSchema,
packageId, organizationId, facilityId, caseId, verificationId, createdAt,
versions (verification policy id/version, evidence schema, canonicalization, hash algorithm, builder),
payloadSha256, artifactCount, artifacts [{id, kind, sha256}] sorted by kind then id
```

`verifyEvidencePackage` (pure, never throws) recomputes: each artifact hash; that the manifest and
payload descriptor lists equal the artifacts; the payload hash; the manifest hash; and the identity
fields across package, manifest and payload. `EvidenceService.load` also requires the stored bytes to
be canonical and to match the index record, so a forger who recomputes every hash inside a replaced
package is still caught. This is hash-based evidence, not a blockchain (spec 37). There is no
signature yet; a signing key (`EVIDENCE_SIGNING_SECRET_NAME`) is a later hardening step.

## Snapshot semantics

A package describes the world **at verification time** (D-049).

- Device facts (status, health, assets, firmware, last seen; never keys) are frozen onto the
  completed verification attempt by the verification runner, and `DEVICE:<id>` references resolve to
  that copy, not to the live registry.
- Case, risk event, actions, baselines, audit entries and the policy are embedded as hashed
  snapshots when the package is created and are never re-read.
- Audit references stop at the verification's own completion entry.
- Source records are never modified. Later case activity (a new action, verification, recurrence)
  creates a **new** package; every earlier package stays accessible and byte-identical.

## Source labels

Every package states where its observations came from (`SYNTHETIC_SIMULATOR`,
`PROTOTYPE_HARDWARE`, `MIXED`, `NONE`), a `synthetic` flag and a human label, derived from the
observations it actually cites. Insurer views repeat that label whenever package content is shown.
A simulator result is never presented as a real carrier or property observation.

## Consent (sharing agreements)

An agreement lets one insured organization share chosen scopes for chosen facilities with a
recipient organization during a time window. It is explicit, scope-limited, recipient-limited,
facility-limited, revocable and audited.

Scopes (D-050): `RECOMMENDATION`, `EVENT_SUMMARY`, `ACTION_SUMMARY`, `BEFORE_AFTER_METRICS`,
`VERIFICATION_RESULT`, `VERIFICATION_CONFIDENCE`, `RECURRENCE_STATUS`, `EVIDENCE_ARTIFACTS`,
`INTERVENTION_RECOMMENDATION`, `RAW_TELEMETRY`. **Raw telemetry is off by default**, is never part of
the broad evidence grant, needs a separate permission to grant, and is only released on an explicit
request.

Every insurer read (D-051): the recipient is the authenticated actor's organization; the agreement
must be active now (not revoked, not expired, already effective), cover the facility, and include a
scope for the requested data; otherwise the answer is a uniform denial that does not reveal whether
the target exists. The read is audited (allowed and denied); if the audit cannot be written, nothing
is released. A package that fails integrity verification is withheld.

Revocation sets `revokedAt`/`revokedBy` once, keeps the agreement and all audit history, never
touches packages, and applies to the next read.

## Sharing state (D-052)

| State       | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `NOT_SHARED` | No evidence package exists for the case.                                   |
| `SHAREABLE` | A package exists and nothing has ever been shared.                         |
| `SHARED`    | An active agreement covering the facility releases package content.        |
| `REVOKED`   | Shared before; no active agreement remains (revoked, or expired).          |

Derived from facts, recorded through documentation commands that never alter the physical-risk
state, severity, verification references or `updatedAt`.

## Insurer projections (D-053)

Purpose-built DTOs, one section per scope, no internal object ever returned: recommendation, event
summary, action summary (no notes, actors or attachments), verification result, confidence and data
sufficiency, before/after statistics (never samples), recurrence, and evidence-package metadata
(hashes, integrity, artifact descriptors; raw observations are only counted). No sensor dashboard.

## Known limitations

- Hashes detect change; they do not prove who created a package (no signature yet).
- The in-memory stores are local only; real object storage and transactions arrive in S9.
- Identity is the development directory, not authentication.
- Expiry is enforced on every read, but the stored case sharing state catches up on the next
  scheduler tick, and `REVOKED` also covers expiry.
- There is no human-readable PDF; the JSON package and manifest are the artifact.
