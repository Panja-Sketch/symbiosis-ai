#include "sym_sequence.h"

namespace sym {

static const char* const kKeyReserved = "seq_hi";

SequenceCounter::SequenceCounter(KeyValueStore* store)
    : store_(store), current_(0), reserved_(0), ready_(false) {}

bool SequenceCounter::begin(uint64_t seed_if_absent) {
  ready_ = false;
  uint64_t hi = 0;
  StoreResult r = store_->load_u64(kKeyReserved, &hi);
  if (r == StoreResult::kError) return false;
  if (r == StoreResult::kAbsent) {
    if (seed_if_absent == 0 || seed_if_absent > kSeqMax) return false;
    hi = seed_if_absent;
    if (!store_->save_u64(kKeyReserved, hi)) return false;
  }
  // Everything up to `hi` may already have been used before the last reset.
  current_ = hi;
  reserved_ = hi;
  ready_ = hi <= kSeqMax;
  return ready_;
}

uint64_t SequenceCounter::next() {
  if (!ready_) return 0;
  uint64_t candidate = current_ + 1;
  if (candidate > kSeqMax) return 0;
  if (candidate > reserved_) {
    uint64_t new_hi = candidate + kSeqBlock - 1;
    if (new_hi > kSeqMax) new_hi = kSeqMax;
    if (!store_->save_u64(kKeyReserved, new_hi)) return 0;  // cannot persist: do not send
    reserved_ = new_hi;
  }
  current_ = candidate;
  return candidate;
}

}  // namespace sym
