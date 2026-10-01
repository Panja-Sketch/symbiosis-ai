#pragma once
// Device health reported in heartbeats (HEALTHY | DEGRADED | FAULT, packages/contracts/src/edge.ts).
// Health reflects what the sensors are ACTUALLY doing, not what init once said. A required sensor
// (vibration, current) that is missing makes the device FAULT; the supporting sensor (zone
// temperature/humidity) makes it DEGRADED. "Unknown" is represented by not sending at all.
#include <stdint.h>

namespace sym {

enum class Health : uint8_t { kHealthy, kDegraded, kFault };

struct SensorStatus {
  bool sht41_ok;    // zone temperature / humidity (supporting)
  bool mpu6050_ok;  // vibration (required)
  bool ina219_ok;   // Fan A current (required)
};

Health evaluate_health(const SensorStatus& s);
/** Wire value: "HEALTHY", "DEGRADED" or "FAULT". */
const char* health_name(Health h);

enum class SensorId : uint8_t { kSht41 = 0, kMpu6050 = 1, kIna219 = 2 };

/**
 * Tracks each sensor from its init result and from consecutive read failures, so a sensor that
 * dies after boot stops counting as healthy within kFailLimit samples.
 */
class SensorTracker {
 public:
  static constexpr uint8_t kFailLimit = 3;
  SensorTracker();
  void set_init(SensorId id, bool ok);
  void report_read(SensorId id, bool ok);
  SensorStatus status() const;

 private:
  bool init_ok_[3];
  uint8_t fails_[3];
};

}  // namespace sym
