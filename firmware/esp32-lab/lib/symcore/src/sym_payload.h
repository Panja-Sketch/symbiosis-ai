#pragma once
// Canonical edge v1 bodies (packages/contracts/src/edge.ts, spec section 33). Field names stay
// source specific; the server's shared edge-v1 mapping converts them (current_ma -> A, ...).
// A reading the sensors could not produce is OMITTED, never invented. `fan_a_load_pct` is not
// physically measured on this prototype and is never sent.
#include <stddef.h>
#include <stdint.h>

#include "sym_health.h"

namespace sym {

/** Provenance label for physical data (the simulator has its own, different label). */
constexpr const char* kSourceHardware = "HARDWARE";

struct Sample {
  uint64_t epoch_s;  // trusted Unix seconds at the end of the sampling window
  bool has_temperature;
  float temperature_c;
  bool has_humidity;
  float relative_humidity_pct;
  bool has_vibration;
  float vibration_rms_ms2;
  bool has_current;
  float current_ma;
  bool has_fan_b;
  bool fan_b_running;  // observed output state of the Fan B drive, see docs
};

bool sample_has_readings(const Sample& s);

/** "YYYY-MM-DDTHH:MM:SSZ" (UTC). Returns the length (20) or 0 if `cap` is too small. */
size_t format_iso8601(uint64_t epoch_s, char* out, size_t cap);

/** IDs and versions are emitted without JSON escaping, so they are limited to [A-Za-z0-9._+-]. */
bool is_safe_token(const char* s);

/** Returns the body length, or 0 on overflow / invalid identity / empty batch. */
size_t serialize_telemetry(char* out, size_t cap, const char* device_id,
                           const char* firmware_version, const Sample* batch, size_t count);

size_t serialize_heartbeat(char* out, size_t cap, const char* device_id,
                           const char* firmware_version, uint64_t sent_epoch_s, Health health);

}  // namespace sym
