# Hardware (S10)

PROJECT_SPEC.md (Parts XI-XII, sections 26-34 and 47) remains the source of truth for _what_ the
hardware must prove. This file records how S10 implements it and, above all, **what has and has
not been demonstrated on a real device**. Build, wiring, calibration, recovery and troubleshooting
details are in [firmware/esp32-lab/README.md](../firmware/esp32-lab/README.md).

## Honest status

| Item                                                                  | Status                                    |
| --------------------------------------------------------------------- | ----------------------------------------- |
| Firmware compiles clean (5 environments, pinned toolchain)            | DONE                                      |
| Host tests, S2 known-answer vector reproduced by the firmware code    | DONE (31 tests, 8,761 checks)             |
| Server accepts firmware-signed requests; replay/tamper/stale/key/seq  | DONE (in-process, real edge handler)      |
| Provisioning script and logic (unit-tested; dry run)                  | DONE; **not yet run against the project** |
| Device flashed and run on the bench; gates H0-H8                      | **NOT RUN: no device attached**           |
| Real signed telemetry from an ESP32 to the deployed API               | **NOT RUN**                               |
| Physical hero loop, evidence package, recurrence                      | **NOT RUN**                               |

S10 is therefore **IN_PROGRESS**, not COMPLETE. Nothing in this file is a hardware result.

## Provenance

Physical packets carry `source: "HARDWARE"`; the server routes them to the ESP32 source adapter
(`sourceType = HARDWARE`, adapter `esp32-edge-v1`), and evidence packages built from them are
labelled `PROTOTYPE_HARDWARE` with `synthetic: false` (existing S6 behaviour; covered by
`adapters/esp32/src/esp32.test.ts`). Simulator data stays `SYNTHETIC_SIMULATOR`. Mixed windows are
labelled `MIXED`.

## Logical mapping (server side)

`createBenchDeviceRecord` (adapters/esp32) is the registry template. One device, three assets, all
existing logical ids that the versioned verification policy already names, so no policy change:

| Signal                                   | Logical asset    |
| ---------------------------------------- | ---------------- |
| `vibration_rms`, `current` (default)     | `AST-SIM-FAN-A`  |
| `temperature`, `relative_humidity`       | `AST-SIM-ZONE-1` |
| `equipment_running` (`chiller_b_running`) | `AST-SIM-FAN-B`  |

Expected signals exclude `load_percent` and `outdoor_temperature` (not measured). Absent load puts
the baseline in the default operating mode, separate from simulator baselines (which send load).
Do not run the simulator and the bench against the same assets simultaneously, and wait out the
recurrence watch (1 h) of any earlier synthetic case on these assets, otherwise a hardware
deterioration could reopen the synthetic case instead of opening its own.

## Acceptance (spec section 47 and the S10 gates)

Fill the Result column on the bench. Do not mark S10 COMPLETE until every row has a real result.

| Gate | What must be true                                                              | How                                      | Result                |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------- | --------------------- |
| H0   | boots, serial diagnostics, version, device id, Wi-Fi state                      | `bringup` serial                         | NOT RUN               |
| H1   | 0x40, 0x44, 0x68 all detected; sensors init                                    | `bringup` `a`                            | NOT RUN               |
| H2   | SHT41 responds to the environment                                               | `bringup`/`sensor_test`, smoke           | NOT RUN               |
| H3   | vibration metric clearly separates fault OFF vs ON                              | `sensor_test`, smoke (p90/p10 >= 3x)     | NOT RUN               |
| H4   | Fan A current stable; Fan A power loss visible                                  | `sensor_test`, smoke                     | NOT RUN               |
| H5   | rocker physically controls Fan B; state reported                                | `bringup` `i`, `demo`                    | NOT RUN               |
| H6   | button physically toggles the vibration motor                                   | `bringup` `i`, `demo`                    | NOT RUN               |
| H7   | firmware HMAC equals the S2 vector byte for byte                                | `signing_test` (and host test: PASS)     | host PASS; device NOT RUN |
| H8   | real ESP32 telemetry 2xx, in canonical storage; identical resend rejected       | `cloud_test` (`REPLAY_PROBE`), smoke B   | NOT RUN               |

Then the hero scenario (README, "Hero scenario on the bench") and the evidence/consent steps.

## Open engineering questions the bench must answer (spec H4)

The compound rule needs vibration z >= 2, current deviation >= 8 % **and** a context branch. The rig
has no outdoor temperature, so the zone-temperature slope (> 0 degC/h over 5 min) is the only
branch, and the vibration motor shares the 5 V rail with Fan A, so whether Fan A's current moves 8 %
is unknown until measured. Do not fake readings. If the physical behaviour cannot satisfy the
production rule, record the measurements and add a separate, versioned **demo** configuration in
`config/demo/`, clearly labelled, without changing the production principle.

## Evidence and consent (manual steps in the web app)

After a verified hardware case: the customer shares evidence (consent), the insurer persona opens
the evidence view; check the package label reads prototype hardware and that revoking consent blocks
the insurer. The cloud smoke lists this as a manual `SKIPPED_HARDWARE` item.

## Security properties of the device path

HMAC authentication over the raw body, replay protection (nonce, strictly increasing persisted
sequence, 5-minute window), TLS with pinned Google Trust Services roots, device key only in Secret
Manager + the local flash image, no key in logs (static test), no cloud-to-actuator path (static
test). Prototype limits: key in plain flash, `source` is trusted from the authenticated device (the
registry does not yet bind a device to allowed sources), one Wi-Fi network, no OTA, no MQTT.
