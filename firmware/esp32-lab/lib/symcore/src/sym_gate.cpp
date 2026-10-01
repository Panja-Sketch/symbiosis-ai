#include "sym_gate.h"

namespace sym {

Block send_block_reason(const GateState& g) {
  if (!g.kat_passed) return Block::kKatFailed;
  if (!g.key_loaded) return Block::kNoKey;
  if (g.latched) return Block::kLatched;
  if (!g.wifi_up) return Block::kNoWifi;
  if (!g.time_synced) return Block::kNoTime;
  if (!g.sequence_ready) return Block::kNoSequence;
  return Block::kNone;
}

const char* block_name(Block b) {
  switch (b) {
    case Block::kNone:
      return "none";
    case Block::kKatFailed:
      return "signing-self-test-failed";
    case Block::kNoKey:
      return "no-device-key";
    case Block::kLatched:
      return "latched-operator-action";
    case Block::kNoWifi:
      return "no-wifi";
    case Block::kNoTime:
      return "clock-not-synced";
    case Block::kNoSequence:
      return "sequence-not-ready";
  }
  return "unknown";
}

}  // namespace sym
