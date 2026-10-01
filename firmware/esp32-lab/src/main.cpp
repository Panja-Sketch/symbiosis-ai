// Symbiosis AI - S10 ESP32 bench firmware.
//
// The firmware only: initialises hardware, reads sensors, computes the local vibration RMS,
// reports observed output state, keeps a persistent sequence, signs and sends telemetry and
// heartbeats, and prints diagnostics. It does NOT decide risk, verification or recommendations,
// and it has no cloud-to-equipment control path (io.cpp is driven only by the local rocker/button).
//
// Modes are selected at build time (platformio.ini): BRINGUP, SENSOR_TEST, SIGNING_TEST,
// CLOUD_TEST, DEMO. One source tree, no divergent copies.
#include <Arduino.h>
#include <string.h>

#include "config.h"
#include "diag.h"
#include "io.h"
#include "net.h"
#include "pins.h"
#include "sensors.h"
#include "sym_health.h"
#include "sym_kat.h"
#include "sym_payload.h"
#include "uplink.h"

namespace {

sym::SensorTracker g_tracker;
bool g_kat_ok = false;
uint32_t g_last_sample_ms = 0;
uint32_t g_last_status_ms = 0;
bool g_first_sample_done = false;

const char* mode_name() {
#if SYM_MODE == SYM_MODE_BRINGUP
  return "BRINGUP";
#elif SYM_MODE == SYM_MODE_SENSOR_TEST
  return "SENSOR_TEST";
#elif SYM_MODE == SYM_MODE_SIGNING_TEST
  return "SIGNING_TEST";
#elif SYM_MODE == SYM_MODE_CLOUD_TEST
  return "CLOUD_TEST";
#else
  return "DEMO";
#endif
}

void banner() {
  Serial.println();
  LOGF("boot", "Symbiosis AI bench firmware %s", SYM_FW_VERSION);
  LOGF("boot", "mode=%s device_id=%s key_id=%s", mode_name(), SYM_DEVICE_ID, SYM_KEY_ID);
  LOGF("boot", "api=%s", SYM_API_BASE_URL);
}

void run_known_answer_test() {
  char detail[32];
  g_kat_ok = sym::signing_self_test(detail, sizeof(detail));
  if (g_kat_ok) {
    LOGF("kat", "S2 signing known-answer test PASS (body hash, signing material, HMAC match)");
  } else {
    LOGF("kat", "S2 signing known-answer test FAIL at stage '%s': telemetry sending is disabled",
         detail);
  }
}

__attribute__((unused)) void init_sensors() {
  sensors::i2c_begin();
  const int found = sensors::i2c_scan_report();
  const bool sht = sensors::sht41_init();
  const bool mpu = sensors::mpu6050_init();
  const bool ina = sensors::ina219_init();
  g_tracker.set_init(sym::SensorId::kSht41, sht);
  g_tracker.set_init(sym::SensorId::kMpu6050, mpu);
  g_tracker.set_init(sym::SensorId::kIna219, ina);
  LOGF("sensors", "init: SHT41=%s MPU6050=%s INA219=%s (%d/3 addresses seen)", sht ? "OK" : "FAIL",
       mpu ? "OK" : "FAIL", ina ? "OK" : "FAIL", found);
  LOGF("sensors", "health=%s", sym::health_name(sym::evaluate_health(g_tracker.status())));
}

void input_tick() { io::poll(millis()); }

/** One sampling cycle: reads every sensor, updates health, returns what could be measured. */
sym::Sample take_sample(float* bus_v) {
  sym::Sample s;
  memset(&s, 0, sizeof(s));
  s.epoch_s = net::epoch_seconds();  // 0 unless the clock is synced

  float t = 0, rh = 0;
  const bool sht_ok = sensors::sht41_read(&t, &rh);
  g_tracker.report_read(sym::SensorId::kSht41, sht_ok);
  if (sht_ok) {
    s.has_temperature = s.has_humidity = true;
    s.temperature_c = t;
    s.relative_humidity_pct = rh;
  }

  float vib = 0;
  const bool mpu_ok = sensors::mpu6050_vibration(&vib, input_tick);  // ~0.5 s window
  g_tracker.report_read(sym::SensorId::kMpu6050, mpu_ok);
  if (mpu_ok) {
    s.has_vibration = true;
    s.vibration_rms_ms2 = vib;
  }

  float ma = 0, v = 0;
  const bool ina_ok = sensors::ina219_read(&ma, &v);
  g_tracker.report_read(sym::SensorId::kIna219, ina_ok);
  if (ina_ok) {
    s.has_current = true;
    s.current_ma = ma;
    if (bus_v != nullptr) *bus_v = v;
  }

  // Observed state of the Fan B drive pin (what is actually on the gate), not a cloud request.
  s.has_fan_b = true;
  s.fan_b_running = io::fan_b_driven();
  return s;
}

void print_sample(const sym::Sample& s, float bus_v) {
  const sym::Health h = sym::evaluate_health(g_tracker.status());
  LOGF("sample",
       "T=%.2fC RH=%.1f%% vib=%.4fm/s2 I=%.1fmA (bus %.2fV) fanB=%s fault=%s rocker=%s health=%s",
       s.has_temperature ? s.temperature_c : NAN, s.has_humidity ? s.relative_humidity_pct : NAN,
       s.has_vibration ? s.vibration_rms_ms2 : NAN, s.has_current ? s.current_ma : NAN, bus_v,
       s.fan_b_running ? "ON" : "off", io::fault_motor_driven() ? "ON" : "off",
       io::rocker_closed() ? "closed" : "open", sym::health_name(h));
}

// ---- BRINGUP -------------------------------------------------------------------------------------
#if SYM_MODE == SYM_MODE_BRINGUP
void bringup_help() {
  LOGF("bringup", "keys: a=I2C scan  s=read sensors once  f=toggle Fan B  m=toggle fault motor  "
                  "i=watch rocker/button  x=stop watching  ?=help");
}

bool g_watch_inputs = false;

void bringup_loop() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    switch (c) {
      case 'a':
        sensors::i2c_scan_report();
        break;
      case 's': {
        float bus_v = 0;
        sym::Sample s = take_sample(&bus_v);
        print_sample(s, bus_v);
        break;
      }
      case 'f':
        io::bench_set_fan_b(!io::fan_b_driven());
        break;
      case 'm':
        io::bench_set_fault_motor(!io::fault_motor_driven());
        break;
      case 'i':
        g_watch_inputs = true;
        LOGF("bringup", "watching inputs: flip the rocker, press the button (x to stop)");
        break;
      case 'x':
        g_watch_inputs = false;
        break;
      case '?':
        bringup_help();
        break;
      default:
        break;
    }
  }
  if (g_watch_inputs) io::bench_print_inputs(millis());
}

#endif  // SYM_MODE_BRINGUP

// ---- sampling modes ------------------------------------------------------------------------------
__attribute__((unused)) void sampling_loop(bool to_uplink, uint32_t interval_ms) {
  const uint32_t now = millis();
  io::poll(now);
  if (!g_first_sample_done || uint32_t(now - g_last_sample_ms) >= interval_ms) {
    g_first_sample_done = true;
    g_last_sample_ms = now;
    float bus_v = 0;
    sym::Sample s = take_sample(&bus_v);
    print_sample(s, bus_v);
    if (to_uplink) {
      uplink::set_health(sym::evaluate_health(g_tracker.status()));
      // Samples are only queued with a trusted wall-clock time; they are never back-dated.
      if (s.epoch_s != 0 && sym::sample_has_readings(s)) uplink::enqueue(s);
    }
  }
  if (to_uplink && uint32_t(now - g_last_status_ms) >= STATUS_PRINT_MS) {
    g_last_status_ms = now;
    uplink::print_status();
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(400);
  banner();
  run_known_answer_test();

#if SYM_MODE == SYM_MODE_SIGNING_TEST
  if (g_kat_ok) {
    LOGF("signing", "H7 PASS: firmware reproduces the S2 vector byte for byte");
  } else {
    LOGF("signing", "H7 FAIL: do not use this firmware");
  }
#elif SYM_MODE == SYM_MODE_BRINGUP
  io::begin(false);
  init_sensors();
  bringup_help();
#elif SYM_MODE == SYM_MODE_SENSOR_TEST
  io::begin(false);
  init_sensors();
#else  // CLOUD_TEST, DEMO
  io::begin(SYM_MODE == SYM_MODE_DEMO);
  init_sensors();
  net::begin();
  uplink::begin(g_kat_ok);
#endif
}

void loop() {
#if SYM_MODE == SYM_MODE_SIGNING_TEST
  delay(5000);
  LOGF("signing", "self-test %s", g_kat_ok ? "PASS" : "FAIL");
#elif SYM_MODE == SYM_MODE_BRINGUP
  bringup_loop();
#elif SYM_MODE == SYM_MODE_SENSOR_TEST
  sampling_loop(false, 2000);
#else
  sampling_loop(true, SAMPLE_INTERVAL_MS);
#endif
}
