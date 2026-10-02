# Source adapters: the vendor-neutral integration boundary (S10)

`PROJECT_SPEC.md` is the architecture; D-088 in `docs/DECISIONS.md` records the design. This file is the
practical description of how a building system reaches the platform.

**No real vendor integration exists yet.** The four profiles shipped in `config/adapters/` are
**synthetic** (`"synthetic": true`, source type `SIMULATOR`) and exist to prove the abstraction. Nothing
here claims a Honeywell, Siemens, Johnson Controls, Schneider or any other integration.

## The path every reading takes

```
SOURCE PAYLOAD (the vendor's own JSON, unchanged)
  -> signed request to POST /edge/v1/source (HMAC, timestamp, nonce, sequence; same as every edge route)
  -> the device record names the source profile (the request cannot choose one)
  -> VERSIONED ADAPTER MAPPING (declarative data, pinned by the API into the event)
  -> CANONICAL OBSERVATION (signal, canonical unit, asset, observedAt, source labels)
  -> VALIDATION (bounds, asset placement, plausibility)  -> QUALITY / TRUST
  -> deterministic detection (S3) -> case / alert / workflow (S4-S6)
```

Other signed edge routes (`/edge/v1/telemetry`, `/edge/v1/heartbeat`) remain for a gateway that already
speaks the Symbiosis edge-v1 format (the `edge-device-v1` mapping). `firmware-contracts/` holds the
known-answer signing vectors any gateway implements.

## A mapping is data

`source-mapping.v1` (`packages/normalization/src/source-mapping.ts`) is validated against a closed schema:

| Element      | Meaning                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `timestamp`  | a payload path and a format: `ISO_8601`, `EPOCH_SECONDS` or `EPOCH_MILLIS`                            |
| `asset`      | a payload path and a map from the vendor's tag to a platform asset id, or a fixed asset              |
| `fields[]`   | canonical `signal`, source `path`, `valueType` (number or boolean), `unit`, optional `bounds`, enum  |
| `unit`       | `{fixed}` or `{path, allowed[]}`; every accepted unit must convert to the canonical unit             |
| `bounds`     | rejects an implausible converted value (`OUT_OF_BOUNDS`)                                              |
| `enum`       | maps vendor text states (for example `RUN`/`STOP`) to booleans                                       |

Paths are dotted keys and `[n]` indexes over own properties only. There is **no expression, script,
regular expression or callback**; unknown keys, unknown or incompatible units, duplicate signals, a
velocity offered for an acceleration signal (no safe conversion) and prototype-pollution keys fail
closed, at definition time and again at payload time. The canonical units are fixed:
temperature degC, relative humidity %, vibration m/s2, current A, load %, flow L/min.

Versions are immutable (`publish` creates version n+1, `activate` selects one, both audited as
`ADAPTER_MAPPING_PUBLISHED`/activation). An ingested payload can always be explained under the version it
used: every ingestion stores an **adapter trace** (profile, version, mode `INGESTED` or `DRY_RUN`, the
source payload, per-field result with source and canonical value, unit, conversion text, asset,
timestamps, rejects and reasons).

## Synthetic profiles

| Profile                  | Shape                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `sim-bas-gateway`        | flat JSON, ISO-8601 timestamp, one equipment tag (`CH-01`), acceleration in m/s2 |
| `sim-vibration-gateway`  | epoch milliseconds, channel `motor-DE`, `rms.value` with its own unit (`g` or m/s2) |
| `sim-electrical-meter`   | epoch seconds, `totals.current/load` value+unit pairs (A or mA), contactor state |
| `sim-hvac-controller`    | zone temperature/humidity with a per-reading unit (degC or degF, % or fraction)  |

`GET /api/v1/simulation/adapters/compare` and the Integration Lab show that the flat gateway and the two
specialised devices produce **equivalent** canonical observations for the same physical reading (same
asset, signal and canonical unit; values equal within the stated tolerance of 0.1 %, because sources report
at their own resolution).

## Bound to a device, and to a place

A device record carries its `sourceProfile` and its asset mapping. A reading for an asset the
authenticated device is not registered for is rejected. The simulation's devices are provisioned by
`pnpm seed:sim` (fresh random key per device in Secret Manager, readable only by the API identity; the
platform-pulled weather feed has no key at all).

## Integration Lab (UI)

`/operations/simulation` -> Integration: source payload, adapter mapping, canonical observation,
validation and quality, ingested; per-field source and canonical value and unit, conversion, asset,
timestamps, version and provenance. A dry run (`preview`) never ingests. An editor publishes a new
version after `validate`; invalid mappings are refused with the reasons.

## Adding a real integration later

A real BMS, IoT gateway, equipment API or sensor platform is a **new mapping (or a small bridge that signs
the edge request) plus a device record**. The source type is `BMS`, `OEM_API` or `HARDWARE` (a customer's
gateway), evidence then says `CUSTOMER_INTEGRATION`, never simulation. No risk logic changes: the detector
never sees a vendor name.

## Limits

- Pairing of the two primary signals (vibration and current) is by identical instant (D-088); a production
  ingestion join is an S11 candidate.
- Mappings cover scalar readings; arrays of samples and batch payloads are not mapped yet.
- The synthetic profiles are not validated against any real device.
