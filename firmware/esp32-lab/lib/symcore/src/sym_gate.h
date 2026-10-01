#pragma once
// The single place that decides whether a signed request may leave the device. Sensor sampling
// continues regardless; only the network send is gated. Timestamps are never manufactured: with no
// trusted clock nothing is signed.
#include <stdint.h>

namespace sym {

struct GateState {
  bool kat_passed;       // firmware known-answer signing self-test passed
  bool key_loaded;       // a well-formed 32-byte device key is present
  bool wifi_up;
  bool time_synced;      // SNTP has set a trustworthy wall clock
  bool sequence_ready;   // persisted sequence loaded
  bool latched;          // permanent auth / sequence failure: operator action required
};

enum class Block : uint8_t {
  kNone,
  kKatFailed,
  kNoKey,
  kLatched,
  kNoWifi,
  kNoTime,
  kNoSequence,
};

Block send_block_reason(const GateState& g);
const char* block_name(Block b);

/** Earliest epoch the device clock may report after a real sync (2025-01-01). */
constexpr uint64_t kMinPlausibleEpoch = 1735689600ULL;

}  // namespace sym
