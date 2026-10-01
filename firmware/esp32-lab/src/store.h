#pragma once
// Non-volatile storage (ESP32 NVS via Preferences) for the sequence reservation, and entropy.
#include <stddef.h>
#include <stdint.h>

#include "sym_sequence.h"

namespace store {

/** NVS-backed key/value store. A reboot or power loss keeps the sequence reservation. */
class NvsStore : public sym::KeyValueStore {
 public:
  bool open();
  sym::StoreResult load_u64(const char* key, uint64_t* out) override;
  bool save_u64(const char* key, uint64_t value) override;

 private:
  bool open_ = false;
};

/** Hardware RNG (true entropy while the radio is active; nonces are only made with Wi-Fi up). */
bool random_bytes(uint8_t* buf, size_t n);

}  // namespace store
