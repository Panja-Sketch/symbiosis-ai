#pragma once
// Time-based debouncer: a raw level must hold for `settle_ms` before it becomes the stable level.
#include <stdint.h>

namespace sym {

class Debouncer {
 public:
  explicit Debouncer(uint32_t settle_ms) : settle_ms_(settle_ms) { reset(false, 0); }
  void reset(bool level, uint32_t now_ms) {
    stable_ = level;
    candidate_ = level;
    since_ms_ = now_ms;
  }
  /** Feeds a raw reading. Returns true if the STABLE level changed on this call. */
  bool update(bool raw, uint32_t now_ms) {
    if (raw == stable_) {
      candidate_ = raw;
      since_ms_ = now_ms;
      return false;
    }
    if (raw != candidate_) {
      candidate_ = raw;
      since_ms_ = now_ms;
      return false;
    }
    if (uint32_t(now_ms - since_ms_) >= settle_ms_) {  // wrap-safe
      stable_ = raw;
      return true;
    }
    return false;
  }
  bool stable() const { return stable_; }

 private:
  uint32_t settle_ms_;
  bool stable_;
  bool candidate_;
  uint32_t since_ms_;
};

}  // namespace sym
