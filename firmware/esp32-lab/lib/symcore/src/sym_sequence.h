#pragma once
// Persistent, strictly increasing request sequence (decision D-017: the server rejects reuse and
// rollback per device+key). The persisted value is a RESERVATION ceiling: the counter writes
// `hi = next + kSeqBlock - 1` ahead of use, so a reboot resumes above anything ever sent, and
// flash is written once per block instead of once per request. Gaps are allowed by the server.
#include <stdint.h>

namespace sym {

constexpr uint64_t kSeqBlock = 64;
/** The server accepts seq up to 15 decimal digits. */
constexpr uint64_t kSeqMax = 999999999999999ULL;

enum class StoreResult { kFound, kAbsent, kError };

class KeyValueStore {
 public:
  virtual ~KeyValueStore() {}
  virtual StoreResult load_u64(const char* key, uint64_t* out) = 0;
  virtual bool save_u64(const char* key, uint64_t value) = 0;
};

class SequenceCounter {
 public:
  explicit SequenceCounter(KeyValueStore* store);
  /**
   * Loads the reservation. If the store has no value (first boot or erased flash) the counter is
   * seeded from `seed_if_absent` = trusted Unix seconds: the request rate is far below 1/s, so a
   * time-seeded sequence stays above anything an earlier life of this device could have used.
   * A store read ERROR is a failure: the counter is never started from zero.
   */
  bool begin(uint64_t seed_if_absent);
  bool ready() const { return ready_; }
  /** Returns the next sequence number, persisted before use. 0 means "do not send". */
  uint64_t next();

 private:
  KeyValueStore* store_;
  uint64_t current_;
  uint64_t reserved_;
  bool ready_;
};

}  // namespace sym
