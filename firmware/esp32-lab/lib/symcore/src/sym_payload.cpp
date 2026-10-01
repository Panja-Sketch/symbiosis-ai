#include "sym_payload.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

namespace sym {

bool sample_has_readings(const Sample& s) {
  return s.has_temperature || s.has_humidity || s.has_vibration || s.has_current || s.has_fan_b;
}

size_t format_iso8601(uint64_t epoch_s, char* out, size_t cap) {
  if (cap < 21) return 0;
  uint64_t days = epoch_s / 86400ULL;
  uint32_t rem = uint32_t(epoch_s % 86400ULL);
  // Howard Hinnant's civil_from_days.
  int64_t z = int64_t(days) + 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  int64_t d = doy - (153 * mp + 2) / 5 + 1;
  int64_t m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  int n = snprintf(out, cap, "%04d-%02d-%02dT%02u:%02u:%02uZ", int(y), int(m), int(d),
                   unsigned(rem / 3600), unsigned((rem % 3600) / 60), unsigned(rem % 60));
  return (n == 20) ? size_t(n) : 0;
}

bool is_safe_token(const char* s) {
  if (s == nullptr || *s == '\0') return false;
  size_t n = strlen(s);
  if (n > 128) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '.' || c == '_' || c == '+' || c == '-';
    if (!ok) return false;
  }
  return true;
}

namespace {
struct Out {
  char* buf;
  size_t cap;
  size_t len;
  bool ok;
  void raw(const char* s) {
    size_t n = strlen(s);
    if (!ok || len + n + 1 > cap) {
      ok = false;
      return;
    }
    memcpy(buf + len, s, n);
    len += n;
    buf[len] = '\0';
  }
  void num(const char* key, float v, const char* fmt, bool* first) {
    if (!isfinite(v)) return;  // never emit NaN/inf
    char tmp[48];
    int n = snprintf(tmp, sizeof(tmp), fmt, key, double(v));
    if (n <= 0 || size_t(n) >= sizeof(tmp)) {
      ok = false;
      return;
    }
    if (!*first) raw(",");
    raw(tmp);
    *first = false;
  }
};
}  // namespace

size_t serialize_telemetry(char* out, size_t cap, const char* device_id,
                           const char* firmware_version, const Sample* batch, size_t count) {
  if (cap == 0 || count == 0 || count > 100) return 0;
  if (!is_safe_token(device_id) || !is_safe_token(firmware_version)) return 0;
  Out o = {out, cap, 0, true};
  out[0] = '\0';
  o.raw("{\"device_id\":\"");
  o.raw(device_id);
  o.raw("\",\"firmware_version\":\"");
  o.raw(firmware_version);
  o.raw("\",\"source\":\"");
  o.raw(kSourceHardware);
  o.raw("\",\"batch\":[");
  size_t emitted = 0;
  for (size_t i = 0; i < count; i++) {
    const Sample& s = batch[i];
    if (!sample_has_readings(s)) continue;
    char ts[24];
    if (format_iso8601(s.epoch_s, ts, sizeof(ts)) == 0) return 0;
    if (emitted > 0) o.raw(",");
    o.raw("{\"observed_at\":\"");
    o.raw(ts);
    o.raw("\",\"readings\":{");
    bool first = true;
    if (s.has_temperature) o.num("temperature_c", s.temperature_c, "\"%s\":%.2f", &first);
    if (s.has_humidity) o.num("relative_humidity_pct", s.relative_humidity_pct, "\"%s\":%.1f", &first);
    if (s.has_vibration) o.num("vibration_rms_ms2", s.vibration_rms_ms2, "\"%s\":%.4f", &first);
    if (s.has_current) o.num("current_ma", s.current_ma, "\"%s\":%.1f", &first);
    if (s.has_fan_b) {
      if (!first) o.raw(",");
      o.raw(s.fan_b_running ? "\"chiller_b_running\":true" : "\"chiller_b_running\":false");
      first = false;
    }
    o.raw("}}");
    if (first) return 0;  // all readings were non-finite: nothing to send for this sample
    emitted++;
  }
  o.raw("]}");
  if (!o.ok || emitted == 0) return 0;
  return o.len;
}

size_t serialize_heartbeat(char* out, size_t cap, const char* device_id,
                           const char* firmware_version, uint64_t sent_epoch_s, Health health) {
  if (cap == 0 || !is_safe_token(device_id) || !is_safe_token(firmware_version)) return 0;
  char ts[24];
  if (format_iso8601(sent_epoch_s, ts, sizeof(ts)) == 0) return 0;
  int n = snprintf(out, cap,
                   "{\"device_id\":\"%s\",\"firmware_version\":\"%s\",\"sent_at\":\"%s\","
                   "\"health\":\"%s\"}",
                   device_id, firmware_version, ts, health_name(health));
  return (n > 0 && size_t(n) < cap) ? size_t(n) : 0;
}

}  // namespace sym
