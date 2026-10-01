#include "sym_vibration.h"

#include <math.h>

namespace sym {

void VibrationAccumulator::reset() {
  n_ = 0;
  for (int i = 0; i < 3; i++) {
    sum_[i] = 0;
    sumsq_[i] = 0;
  }
}

void VibrationAccumulator::add(int16_t ax, int16_t ay, int16_t az) {
  const int64_t v[3] = {ax, ay, az};
  for (int i = 0; i < 3; i++) {
    sum_[i] += v[i];
    sumsq_[i] += v[i] * v[i];
  }
  n_++;
}

bool VibrationAccumulator::rms_ms2(float lsb_per_g, float* out) const {
  if (n_ < 2 || lsb_per_g <= 0.0f) return false;
  const double n = double(n_);
  double var_total = 0.0;
  for (int i = 0; i < 3; i++) {
    // (n * sum(x^2) - (sum x)^2) / n^2, computed exactly in 64-bit integers first.
    int64_t num = int64_t(n_) * sumsq_[i] - sum_[i] * sum_[i];
    if (num < 0) num = 0;
    var_total += double(num) / (n * n);
  }
  *out = float(sqrt(var_total) / double(lsb_per_g) * double(kStandardGravity));
  return true;
}

}  // namespace sym
