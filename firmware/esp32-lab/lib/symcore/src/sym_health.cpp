#include "sym_health.h"

namespace sym {

Health evaluate_health(const SensorStatus& s) {
  if (!s.mpu6050_ok || !s.ina219_ok) return Health::kFault;
  if (!s.sht41_ok) return Health::kDegraded;
  return Health::kHealthy;
}

const char* health_name(Health h) {
  switch (h) {
    case Health::kHealthy:
      return "HEALTHY";
    case Health::kDegraded:
      return "DEGRADED";
    case Health::kFault:
      return "FAULT";
  }
  return "FAULT";
}

SensorTracker::SensorTracker() {
  for (int i = 0; i < 3; i++) {
    init_ok_[i] = false;
    fails_[i] = 0;
  }
}

void SensorTracker::set_init(SensorId id, bool ok) {
  init_ok_[static_cast<int>(id)] = ok;
  fails_[static_cast<int>(id)] = 0;
}

void SensorTracker::report_read(SensorId id, bool ok) {
  uint8_t& f = fails_[static_cast<int>(id)];
  if (ok) {
    f = 0;
  } else if (f < 255) {
    f++;
  }
}

SensorStatus SensorTracker::status() const {
  SensorStatus s;
  s.sht41_ok = init_ok_[0] && fails_[0] < kFailLimit;
  s.mpu6050_ok = init_ok_[1] && fails_[1] < kFailLimit;
  s.ina219_ok = init_ok_[2] && fails_[2] < kFailLimit;
  return s;
}

}  // namespace sym
