#pragma once
// Vibration metric: RMS of the AC component of 3-axis acceleration over a short window.
//   per axis: remove the window mean (gravity / tilt / DC offset), compute the variance
//   metric   = sqrt(var_x + var_y + var_z) converted to m/s^2
// i.e. the RMS magnitude of the dynamic acceleration vector. Integer sums keep the result exact
// and deterministic. This is a bench indicator for fault ON/OFF contrast, not a certified
// industrial vibration measurement (no ISO 10816 band-limiting or velocity integration).
#include <stddef.h>
#include <stdint.h>

namespace sym {

constexpr float kStandardGravity = 9.80665f;
/** Accelerometer range +/-4 g: 8192 LSB per g. */
constexpr float kMpuLsbPerG4g = 8192.0f;

class VibrationAccumulator {
 public:
  VibrationAccumulator() { reset(); }
  void reset();
  void add(int16_t ax, int16_t ay, int16_t az);
  uint32_t count() const { return n_; }
  /** False when fewer than 2 samples were added. */
  bool rms_ms2(float lsb_per_g, float* out) const;

 private:
  uint32_t n_;
  int64_t sum_[3];
  int64_t sumsq_[3];
};

}  // namespace sym
