# Session Handoff

## Current phase

S10 — physical ESP32 hardware integration (IN PROGRESS: software side done and verified; **the physical bench gates H0-H8 and the cloud/physical hero loop have NOT been run**)

## Current phase status

IN_PROGRESS. Do **not** mark S10 COMPLETE until `docs/HARDWARE.md` has a real result for every gate H0-H8 and the physical hero loop has been proven. S11 is not started.

## Last completed phase

S9 — Google Cloud production adapters and deployment foundation (S0 to S9 COMPLETE).

## Completed work (S10 software side)

- **Contract extracted from code, not from the old roadmap** (see firmware README "Signing protocol"): `POST /edge/v1/telemetry|heartbeat`; headers `X-Device-Id`, `X-Key-Id`, `X-Timestamp` (epoch seconds, window 300 s old / 60 s ahead), `X-Nonce` (`[A-Za-z0-9_-]{16,64}`), `X-Seq` (decimal, strictly increasing per device+key, gaps allowed, telemetry and heartbeat share it), `X-Signature`; material `METHOD\nPATH\nTS\nNONCE\nSEQ\nhex(SHA-256(raw body))`, no trailing LF; HMAC-SHA256 with the raw 32-byte key (64 hex in Secret Manager), lowercase hex; success is 202 (telemetry) / 200 (heartbeat); 401/403/409/400 mapping as in `apps/api/src/edge-handler.ts`.
- **Firmware** (`firmware/esp32-lab`, PlatformIO, platform `espressif32@6.9.0` = Arduino-ESP32 2.0.17, toolchain xtensa 8.4.0+2021r2-patch5, **no third-party libraries**): portable core `lib/symcore` (SHA-256/HMAC, signing material, nonce, sequence, payload, retry, health, send gate, vibration, conversions, debounce, bounded queue) plus `src/` (register-level SHT41/MPU6050/INA219 drivers, io, net/SNTP, TLS transport with pinned Google Trust Services roots, uplink FreeRTOS task, modes). Five environments: `bringup`, `sensor_test`, `signing_test`, `cloud_test` (with replay probe), `demo`. All five **compile clean, no warnings** (demo: flash 73 %, RAM 18 %). Pins locked: SDA 21, SCL 22, Fan B MOSFET 26, fault-motor MOSFET 27, rocker 32, button 33.
- **Server side**: `createBenchDeviceRecord` in `adapters/esp32` (device -> `AST-SIM-FAN-A` default, zone signals -> `AST-SIM-ZONE-1`, `chiller_b_running` -> `AST-SIM-FAN-B`; expected signals exclude `load_percent`/`outdoor_temperature`). Provenance uses the existing HARDWARE -> PROTOTYPE_HARDWARE chain, unchanged. Only other backend change: `FirestoreDeviceRegistry.create` (atomic).
- **Provisioning** (`adapters/gcp/src/provision.ts`, `scripts/provision-device.ts`, `pnpm provision:device`): fresh key, Secret Manager, atomic Firestore create, rollback, rotation, key never printed. **Run against the real project**: `DEV-PHX-BENCH-001` / `KEY-PHX-BENCH-001` / `ORG-SIM-001` / `FAC-SIM-001`. The key is in Secret Manager and in the git-ignored `.secrets/devices/DEV-PHX-BENCH-001.KEY-PHX-BENCH-001.json` and `firmware/esp32-lab/include/secrets.h` on the operator's machine (Wi-Fi fields there are still placeholders).
- **Tests/tools**: `firmware/esp32-lab/test/host` (31 tests), `tests/integration/firmware-compat.test.ts` (firmware-signed requests through the real edge handler), `tests/unit/firmware-hygiene.test.ts`, `adapters/gcp/src/provision.test.ts`, `adapters/esp32/src/esp32.test.ts`, `scripts/smoke-s10.ts`, `scripts/mutation-s10.mjs`.
- Docs: firmware README (wiring, setup, provisioning, signing, NVS, recovery, calibration, hero steps, troubleshooting), `docs/HARDWARE.md`, D-078 to D-084, README, GCP_RUNTIME.

## NOT done (needs the physical device)

- Flashing and running on the bench: **H0 to H8 are all NOT RUN** (the H7 vector is proven on the host and compiled into every build, but not observed on a device).
- Real ESP32 telemetry to the deployed API, the on-device **replay probe**, canonical-observation check of real data.
- Calibration (spec H4): whether the real Fan A current moves >= 8 % with the motor on and whether the zone-temperature slope branch can fire (the rig has no outdoor temperature). If not, a separate versioned demo config under `config/demo/` is needed; none was created.
- Physical hero loop (baseline, deterioration, human mitigation, verification, evidence package, recurrence, consent and insurer view). Sequence-recovery drill, offline buffering drill on the device.

## Commands executed

`pwd`, `git status`, `git log`, PlatformIO builds (5 envs), host C++ build with zig (`python -m ziglang c++` in a scratch venv), `pnpm install`, `pnpm lint/typecheck/test/format:check/test:e2e`, `pnpm smoke:s2` to `smoke:s8`, `pnpm smoke:s10` (host part; cloud part read-only), `node scripts/mutation-s10.mjs`, `pnpm provision:device` (real project), a live negative-security probe of the deployed API (see below), `openssl s_client`/`curl` to pin the TLS roots.

## Exact test results

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: exit 0.
- `pnpm test` (`SYMBIOSIS_REQUIRE_EMULATOR=1`, `SYMBIOSIS_REQUIRE_FIRMWARE_HOST=1`, `SYM_CXX` set): **68 files, 993 tests, 993 passed** (S9: 965; +28: 6 firmware-compat, 10 hygiene, 9 provisioning, 3 ESP32 adapter). Without a C++ compiler the firmware-compat cases skip with a warning (fail if `SYMBIOSIS_REQUIRE_FIRMWARE_HOST=1`).
- Firmware host tests: **31 tests, 8,761 checks, 0 failures**; the S2 vector (body hash, signing material, signature) is reproduced and compared with the JSON fixtures byte for byte; SHA-256/HMAC also agree with Node `crypto` over lengths 0..1000 and several key sizes.
- **E2E (Playwright): 26 passed.** Local smokes `s2` to `s8`: all exit 0 (PASSED).
- `pnpm smoke:s10`: host part 3 PASS; physical part `SKIPPED_HARDWARE` (explicitly not a hardware pass). With `SMOKE_S10_CLOUD=1` against the project and the simulator device as a stand-in: device/secret/mapping checks PASS and every hardware check correctly `SKIPPED_HARDWARE` (no HARDWARE observations).
- **Live API, deployed Cloud Run, firmware signer, real provisioned key**: wrong key -> 401 `SIGNATURE_MISMATCH`; altered body -> 401 `SIGNATURE_MISMATCH`; -400 s timestamp -> 401 `STALE_TIMESTAMP`; +120 s -> 401 `FUTURE_TIMESTAMP`; no key in any response. (A valid request was deliberately not sent: it would create fake "hardware" data.) Replay/nonce/sequence rejection is proven in-process against the real handler and must be proven on the device by the `cloud_test` replay probe.
- **Mutation checks** (`scripts/mutation-s10.mjs`, all DETECTED, all restored): 1 sequence reset on reboot, 2 nonce reuse, 3 body hash omitted, 4 wrong material order, 5 key logged, 6 healthy with failed required sensor, 7 replay accepted, 8 firmware mislabels hardware as SIMULATOR (and 8b server adapter), 9 cloud-to-actuator path (firmware include and API response), 10 send before clock sync. Two mutants first failed to compile (not a detection); they were rewritten to compile and then detected.

## Deployed state

Unchanged from S9 (no Cloud Run revision, image or IAM change in S10): revisions `symbiosis-api-00004-gdw`, `symbiosis-web-00004-mgk`, `symbiosis-worker-00004-86k`; API `https://symbiosis-api-554089078085.us-central1.run.app`. New data only: the `DEV-PHX-BENCH-001` registry document and its secret.

## Known issues

- No physical result exists yet (above). The firmware has never executed on a board; driver details (MPU6050 clone ids, INA219 shunt value, MOSFET polarity, SHT41 timing) are untested on hardware.
- The worker picks the source adapter from the authenticated body's `source`; the registry does not bind a device to allowed sources. Hardware and simulator share the logical assets `AST-SIM-*`, so do not run both at once, and wait out the 1 h recurrence watch of any earlier synthetic case on those assets.
- Device key is plain in flash (prototype). Fan B state is the gate read-back, not rotor proof. Sample queue is RAM only (about 10 min). Single Wi-Fi network, no OTA, no MQTT.
- Firmware host/compat tests need a C++ compiler; CI without one skips them (loudly). A scratch toolchain was used here (zig in a venv, PlatformIO core at `C:\pio-sym`, both outside the repo; delete `C:\pio-sym` to reclaim about 1.5 GB).
- S5/S6/S7/S8/S9 open items remain open (see git history of this file).

## Architectural decisions made

`docs/DECISIONS.md` (D-001 to D-084; S10 is D-078 to D-084).

## Current git status

Clean after the S10 handoff commit; `main` pushed to `origin/main` (see `git log`).

## Last known good commit SHA

See `git log`: the S10 handoff commit sits on top of the firmware and provisioning commits.

## Exact next task

Run the physical bench (needs the board), in this order, filling the Result column in `docs/HARDWARE.md`:

1. Put Wi-Fi credentials in `firmware/esp32-lab/include/secrets.h` (it already holds the provisioned device id, key id and key).
2. `pio run -e bringup -t upload` -> H0, H1 (scan), H2-H6 by hand; `sensor_test` for calibration numbers.
3. `pio run -e signing_test -t upload` -> H7 on the device.
4. `pio run -e cloud_test -t upload` -> H8: heartbeat, telemetry 202, `REPLAY_PROBE PASS`; then `SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=symbiosis-ai-2026 pnpm smoke:s10 --confirm-project symbiosis-ai-2026 --device-id DEV-PHX-BENCH-001`.
5. Calibrate (firmware README), decide whether a `config/demo/` configuration is needed, record the decision in `docs/DECISIONS.md`.
6. `pio run -e demo -t upload`, run the hero scenario (README "Hero scenario on the bench"), re-run the smoke, do the consent/insurer steps by hand.
7. Only then set S10 COMPLETE in `docs/IMPLEMENTATION_STATE.md` and write the completion report. Do not start S11.

## Exact commands needed to resume

```
git status && git log --oneline -10
pnpm install
pnpm lint && pnpm typecheck && SYMBIOSIS_REQUIRE_EMULATOR=1 SYMBIOSIS_REQUIRE_FIRMWARE_HOST=1 pnpm test && pnpm format:check
pnpm smoke:s2 && pnpm smoke:s3 && pnpm smoke:s4 && pnpm smoke:s5 && pnpm smoke:s6 && pnpm smoke:s7 && pnpm smoke:s8
pnpm test:e2e
# firmware (host C++ compiler or SYM_CXX; PlatformIO for device builds)
pnpm test:firmware && pnpm smoke:s10
cd firmware/esp32-lab && pio run -e demo
# cloud (opt-in, real project)
SMOKE_S9=1 GCP_PROJECT_ID=symbiosis-ai-2026 pnpm smoke:s9 --confirm-project symbiosis-ai-2026
SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=symbiosis-ai-2026 pnpm smoke:s10 --confirm-project symbiosis-ai-2026 --device-id DEV-PHX-BENCH-001
```

## Cloud resources touched

Project `symbiosis-ai-2026`: **created** Secret Manager secret `symbiosis-device-key-DEV-PHX-BENCH-001-KEY-PHX-BENCH-001` (one version; `secretAccessor` for `symbiosis-api@` on that secret only) and the Firestore document `devices/DEV-PHX-BENCH-001`. **Read only**: Firestore (devices, observations, cases, verifications, evidence packages), Secret Manager metadata (`getSecret`), Cloud Storage listing/reads in the smoke. **Live requests** to the API: four deliberately invalid signed requests (all rejected before any state change). No Cloud Run, Pub/Sub, Scheduler or IAM-policy change beyond the one secret binding.

## Secrets referenced (NAME ONLY)

Secret Manager: `symbiosis-device-key-DEV-SIM-001-KEY-SIM-001`, `symbiosis-device-key-DEV-PHX-BENCH-001-KEY-PHX-BENCH-001`. Git-ignored local files: `.secrets/demo-users.json`, `.secrets/devices/DEV-PHX-BENCH-001.KEY-PHX-BENCH-001.json`, `firmware/esp32-lab/include/secrets.h` (Wi-Fi SSID/password, API URL, device id/key id/key). Environment names: `SYM_WIFI_SSID`, `SYM_WIFI_PASSWORD`, `SYM_CXX`, `SYM_PIO`, `SYMBIOSIS_REQUIRE_FIRMWARE_HOST`, `SMOKE_S10_CLOUD`, `GCP_PROJECT_ID`. No credential is in the repository.
