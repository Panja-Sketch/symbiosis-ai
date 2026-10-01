# ESP32 bench firmware (S10)

Firmware for the physical low-voltage prototype. It measures, signs and reports; it does **not**
decide risk, verification or recommendations, and it has **no cloud-to-equipment control path**
(AI advises, deterministic code decides state, humans act, sensors verify).

> **Status:** compiles clean in all five environments and passes the host tests and the S2
> known-answer vector. It has **not yet been flashed to a board** by the project (no device was
> attached when it was written), so gates H0-H8 are still to be run on the bench. See
> [docs/HARDWARE.md](../../docs/HARDWARE.md) for the acceptance checklist and results table.

## Hardware

ESP32 SP-WROOM-32 / ESP32-S dev board, HiLetgo GY-521 (MPU6050), HiLetgo SHT41, INA219 current
sensor, two 5 V brushless fans, two 3.3 V-logic MOSFET driver modules, a vibration motor, rocker
switch, momentary push button, 5 V / 3 A regulated supply with an inline 5x20 mm fuse, breadboard,
USB cable. **There is no third MOSFET** and no fan-speed control, so no load percentage is claimed.

| Part                  | Role in the demo                          | Canonical signal (server side)                  |
| --------------------- | ----------------------------------------- | ----------------------------------------------- |
| Fan A (via INA219)    | primary cooling equipment, always powered | `current` (from `current_ma`)                   |
| MPU6050 near Fan A    | mechanical condition                      | `vibration_rms` (from `vibration_rms_ms2`)      |
| SHT41                 | cold-zone environment                     | `temperature`, `relative_humidity`              |
| Fan B (MOSFET #1)     | backup cooling equipment                  | `equipment_running` (from `chiller_b_running`)  |
| Vibration motor (#2)  | injected mechanical fault                 | acts only through the MPU6050 (and any current) |
| Rocker switch         | human request to start backup cooling     | Fan B state, as observed on the gate pin        |
| Push button           | local fault on/off toggle                 | never a verification input                      |

## Wiring and pin table (locked)

| Signal              | GPIO | Notes                                                                      |
| ------------------- | ---- | -------------------------------------------------------------------------- |
| I2C SDA             | 21   | shared by INA219 (0x40), SHT41 (0x44), MPU6050 (0x68)                      |
| I2C SCL             | 22   |                                                                            |
| Fan B MOSFET gate   | 26   | active HIGH (`OUTPUT_ACTIVE_LEVEL` in `include/pins.h`)                    |
| Fault-motor MOSFET  | 27   | active HIGH; motor is OFF at every boot                                    |
| Rocker switch       | 32   | other side to GND, internal pull-up; closed = Fan B requested              |
| Push button         | 33   | other side to GND, internal pull-up; press = toggle fault motor            |

None is a strapping, flash or input-only pin. No conflict with the board was found, so the map is
unchanged. If you find one on the bench, record it in `docs/DECISIONS.md` before changing it.

```text
5V supply(+) -- fuse -- rail                         ESP32 3V3 -> sensor VCC (INA219/SHT41/MPU6050)
rail -- INA219 VIN+ ; INA219 VIN- -- Fan A (+) ; Fan A (-) -- GND     (INA219 in series, high side)
rail -- Fan B (+) ; Fan B (-) -- MOSFET#1 drain ; source -- GND ; gate <- GPIO26
rail -- motor (+) ; motor (-) -- MOSFET#2 drain ; source -- GND ; gate <- GPIO27   + flyback diode
All GNDs common (supply, ESP32, MOSFET modules).  ESP32 stays USB powered on the bench.
```

Safety (mandatory): motors and fans are **never** powered from the ESP32 3.3 V rail; common ground;
inline fuse on the 5 V feed; flyback protection on the motor; INA219 in series with Fan A only; no
mains; stop if anything gets abnormally hot; label the rig "bench model / simulation". Check your
MOSFET module's logic polarity and flip `OUTPUT_ACTIVE_LEVEL` if it is inverting. Mount the MPU6050
rigidly on the same board/frame as Fan A and the motor.

## Toolchain (pinned)

PlatformIO (`pip install platformio`), no third-party libraries:

| Component                 | Version                                      |
| ------------------------- | -------------------------------------------- |
| platform `espressif32`    | 6.9.0                                        |
| Arduino-ESP32 framework   | 2.0.17 (`framework-arduinoespressif32` 3.20017) |
| toolchain-xtensa-esp32    | 8.4.0+2021r2-patch5                          |
| esptool                   | 4.5.1                                        |

The three I2C sensors use small register-level drivers in `src/sensors.cpp`; conversions are pure
functions in `lib/symcore` (host-tested). WiFi, HTTPClient, WiFiClientSecure, Wire and Preferences
are part of Arduino-ESP32. Arduino IDE is not supported (the host-tested `lib/symcore` layout is
PlatformIO's). Build output: Flash about 73 % and RAM about 18 % of the default 1.3 MB app slot in
the cloud environments.

## Configuration and secrets

Nothing secret is committed. `include/secrets.h` is **git-ignored**; the committed
`include/secrets.example.h` is a placeholder that compiles but makes the firmware refuse to send.

| Value                 | Where it comes from                                                              |
| --------------------- | -------------------------------------------------------------------------------- |
| Wi-Fi SSID / password | you, in `secrets.h` (or `SYM_WIFI_SSID`/`SYM_WIFI_PASSWORD` when provisioning)   |
| API base URL          | `SYM_API_BASE_URL`: `https://<host>` only, no path, no trailing slash            |
| Device id / key id    | `pnpm provision:device` output                                                   |
| Device key (64 hex)   | generated by `pnpm provision:device`; never printed; stored in Secret Manager    |

```text
GCP_PROJECT_ID=<project> SYM_WIFI_SSID=<ssid> SYM_WIFI_PASSWORD=<pw> \
  pnpm provision:device --confirm-project <project> --device-id DEV-PHX-BENCH-001 --write-firmware-secrets
```

This (operator-only, your own credentials) creates a fresh 32-byte key in Secret Manager
(`symbiosis-device-key-DEV-PHX-BENCH-001-KEY-PHX-BENCH-001`, readable by the API service account
only), registers the device (atomic create, a duplicate id is refused), writes the key to
`.secrets/devices/*.json` and `include/secrets.h` (both git-ignored). The key lives on the device in
the flash image: prototype grade. Production hardware needs protected key storage (secure element or
flash encryption + secure boot) and per-device provisioning at manufacture (S11).

## Build environments (one source tree)

| Env            | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `bringup`      | I2C scan, read sensors, toggle Fan B / motor, watch inputs (serial)  |
| `sensor_test`  | print real measurements every 2 s; actuators and network off         |
| `signing_test` | firmware known-answer HMAC self-test only (gate H7)                  |
| `cloud_test`   | real signed telemetry to the API, then an intentional **replay probe** |
| `demo`         | sensors + local rocker/button + cloud telemetry (hero scenario)      |

```text
cd firmware/esp32-lab
pio run -e signing_test -t upload && pio device monitor      # 115200 baud
```

## Bring-up order (do not skip ahead)

1. **USB serial** (`bringup`): banner prints, firmware version, device id (never the key). **H0**
2. **I2C scan** (`a`): expect 0x40 INA219, 0x44 SHT41, 0x68 MPU6050. **H1**
3. Individual sensors (`s`): SHT41 changes when you breathe on it (**H2**); MPU6050 vibration rises
   when you tap the frame; INA219 shows Fan A current.
4. Fan A current: stable at idle; unplug Fan A and the current collapses. **H4**
5. Fan B MOSFET (`f`): fan spins, serial confirms the gate read-back. **H5 (part)**
6. Vibration motor MOSFET (`m`): motor runs, vibration metric jumps. **H3 (part)**
7. Rocker and button (`i`): one line per debounced change, no chatter. **H5, H6**
8. `sensor_test`: integrated local telemetry, health `HEALTHY`.
9. `signing_test`: serial shows `H7 PASS`. **H7**
10. Provision, then `cloud_test`: Wi-Fi, NTP, heartbeat, telemetry 202, `REPLAY_PROBE PASS`. **H8**
11. `demo`.

## Signing protocol (from the S2 code, authoritative)

`POST <base>/edge/v1/telemetry` (and `/heartbeat`), `Content-Type: application/json`. Headers
`X-Device-Id`, `X-Key-Id`, `X-Timestamp` (epoch **seconds**), `X-Nonce` (`[A-Za-z0-9_-]{16,64}`;
here 24 base64url chars from 18 hardware-random bytes), `X-Seq` (decimal integer), `X-Signature`.

```text
material  = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" SEQ "\n" lowercase-hex(SHA-256(raw body))
signature = lowercase-hex(HMAC-SHA256(raw 32-byte key, material))      # no trailing newline
```

The firmware signs the exact bytes it sends. Server window: timestamp at most 300 s old and 60 s
ahead; nonce unique per device+key; sequence strictly increasing per device+key (gaps allowed;
telemetry and heartbeat share one counter). Success is **202** (telemetry) / 200 (heartbeat).
Known-answer vector: `firmware-contracts/sample-packets/signing-vector.json`. It runs at every
boot (`kat PASS` / `FAIL` in the log); on failure nothing is sent.

## Time

SNTP only (`time.google.com`, `pool.ntp.org`, `time.cloudflare.com`). Nothing is signed or queued
until the clock is synced and plausible (after 2025-01-01). Samples taken before sync are shown on
serial but never queued or back-dated. After a `STALE_TIMESTAMP`/`FUTURE_TIMESTAMP` answer the
firmware re-syncs (bounded retries) before sending again.

## Sequence persistence (NVS)

The persisted value is a **reservation ceiling** in NVS (`symseq/seq_hi`). Before using a number
past the ceiling the firmware writes `number + 63` ahead (one flash write per 64 requests). After any
reboot or power loss it resumes at the ceiling, so it is always above anything previously sent. If
flash is empty (first boot, erased flash) it seeds from trusted epoch seconds, which stays above any
earlier sequence because the device sends far fewer than 1 request per second. An NVS read error
stops sending (it never restarts from zero). It never lowers the sequence after a server error.

## Telemetry, sampling and the vibration metric

- Sample every **5 s** (the verification policy's `expectedIntervalSeconds`); send a batch of up to
  20 samples every 15 s (or sooner when 20 are queued); heartbeat every 30 s and on health change,
  and always before the first telemetry. `firmware_version` is `0.1.0+g<sha>[-dirty]`
  (diagnostics only).
- Body: `{device_id, firmware_version, source:"HARDWARE", batch:[{observed_at, readings}]}`; readings
  `temperature_c`, `relative_humidity_pct`, `vibration_rms_ms2`, `current_ma`, `chiller_b_running`.
  A reading the sensors could not produce is **omitted**. `fan_a_load_pct` is not measured and is
  never sent. No new schema fields.
- **Vibration:** MPU6050, +/-4 g (8192 LSB/g), 260 Hz bandwidth, polled at 1 kHz, **512 samples
  (~0.5 s)** per sample; per axis the window mean (gravity, tilt, DC offset) is removed, then
  `metric = sqrt(var_x + var_y + var_z)` in m/s2 (RMS of the dynamic acceleration vector), computed
  exactly in integers. A bench indicator for fault ON/OFF contrast, **not** a certified industrial
  vibration measurement (no band-limiting, no velocity integration).
- **Current:** INA219 shunt register (10 uV/LSB) over a 0.1 ohm shunt, 32-sample hardware averaging
  plus 8 reads. Change `INA219_SHUNT_OHMS` if your module's shunt differs.
- **Fan B state** is the level read back from the Fan B gate pin: the device state, not proof the
  rotor turns. The operator action itself is never treated as verification.
- Health in heartbeats: all three sensors answering = `HEALTHY`; SHT41 missing = `DEGRADED`; MPU6050
  or INA219 missing (init or 3 consecutive failed reads) = `FAULT`. Never `HEALTHY` with a required
  sensor down. A device that cannot send is "unknown" to the server (not healthy).

## Buffer and retry

RAM queue of **120 samples** (about 10 min); oldest dropped first and counted (`dropped_oldest`),
never written to flash. Observed times are preserved; signing time, nonce and sequence are made at
send time. Outcomes (`lib/symcore/src/sym_retry.cpp`):

| Answer                                  | Action                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| no response, 5xx, 408/425/429           | keep batch, back off 2, 4, ... 60 s                     |
| 401 `STALE_/FUTURE_TIMESTAMP`           | re-sync SNTP, retry (max 5, then latch)                 |
| 409 `NONCE_REPLAY`                      | retry with a fresh nonce (max 3, then latch)            |
| 409 `SEQUENCE_REUSE/ROLLBACK`           | **latch**: stop, operator recovery                      |
| 401 other, 403                          | **latch**: wrong key/unknown device/disabled            |
| 400 and other 4xx                       | batch can never succeed: dropped and counted            |

"Latched" stops sending until reboot (sampling and local control continue) and says why on serial.

## Recovery after a sequence/replay error

Never edit the server's replay state and never lower the counter. Use the existing mechanism: rotate
the key id. Replay state is per device **and key**, so a new key id starts a clean sequence:

```text
pnpm provision:device --confirm-project <p> --device-id DEV-PHX-BENCH-001 \
    --key-id KEY-PHX-BENCH-002 --rotate-key --write-firmware-secrets --force-secrets-header
```

then re-flash. The old key stops being accepted (`activeKeyId` changes).

## Calibration (before you trust any threshold)

Spec gate H4 says do not lock verification thresholds before this experiment. Run the five physical
states for at least 3 minutes each with the `demo` firmware and read the numbers from serial or the
cloud smoke (`pnpm smoke:s10`): (1) normal, (2) fault motor ON, (3) Fan B ON, (4) fault OFF,
(5) back to normal. Record for each: median and spread of `vibration_rms_ms2`, `current_ma`,
`temperature_c`. Then check against the **existing** policy: vibration z >= 2 against the baseline
(needs >= 12 observations over 120 s of healthy running first), current deviation >= 8 %, and one of
the two context branches (outdoor temperature is not available on this rig, so the zone-temperature
slope branch is the only one). If the real current does not move 8 % with the motor on, or the zone
temperature slope is not reliably positive, do **not** fake data: write a separate, versioned demo
configuration under `config/demo/` and document it as demo-only (this was not needed to build the
firmware and has not been determined yet; see docs/HARDWARE.md).

## Hero scenario on the bench

A baseline: Fan A on, fault OFF, Fan B off, 2+ minutes of healthy telemetry. B fault: press the
button (motor ON), keep it on until the platform opens the case. C human action: the facility
manager acknowledges and reports "start backup" in the web app, then flips the rocker (Fan B starts,
`chiller_b_running=true`). The rocker is not the action report. D recovery: press the button (motor
OFF) and keep sending healthy telemetry through the verification window; only the verification
result can say VERIFIED. E recurrence: press the button again inside the recurrence watch (1 h):
the same case is reopened. Do not run the simulator against the same assets at the same time.

## Host tests (no board needed)

```text
pnpm test:firmware            # builds with c++/g++/clang++ or $SYM_CXX and runs 31 tests
pnpm smoke:s10                # host part always; hardware checks report SKIPPED_HARDWARE without a device
```

They cover SHA-256/HMAC vectors, the S2 known-answer vector (byte for byte, against the JSON
fixtures), signing-material order, nonce format/uniqueness, sequence reboot behaviour, payload
serialization, retry classification, health, the send gate, vibration, conversions and debouncing.
`tests/integration/firmware-compat.test.ts` feeds firmware-signed requests to the real edge handler.

## Troubleshooting

| Symptom                                | Check                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| a sensor address is missing            | wiring, 3.3 V, pull-ups on the GY-521/INA219 board, shared ground              |
| MPU6050 `WHO_AM_I` unexpected          | clones report 0x70-0x72; others are refused deliberately                       |
| `kat ... FAIL`                         | do not use that build; rebuild from a clean tree                               |
| `send gate: clock-not-synced`          | Wi-Fi up? UDP 123 allowed? the firmware waits, it never guesses                |
| TLS/HTTP code -1..-11                  | wrong URL, clock off, blocked network; certificate roots are in `ca_certs.h`   |
| 401 `SIGNATURE_MISMATCH` (latched)     | wrong key in `secrets.h`; re-provision (rotate) and re-flash                   |
| 401 `UNKNOWN_KEY_ID`                   | `SYM_KEY_ID` is not the device's active key id                                 |
| 409 sequence (latched)                 | recovery section above                                                         |
| Fan B / motor never moves              | wrong MOSFET polarity (`OUTPUT_ACTIVE_LEVEL`), missing common ground           |
| Fan B gate read-back mismatch          | the gate pin is shorted or driven externally                                   |
| button press missed                    | fixed: uplink runs on its own task, input polling is never blocked by HTTPS    |
| flash > 100 %                          | the cloud environments use the default partition table; keep debug off         |
