#include "store.h"

#include <Preferences.h>
#include <esp_random.h>

namespace store {

namespace {
Preferences g_prefs;
}

bool NvsStore::open() {
  open_ = g_prefs.begin("symseq", false);  // read-write; creates the namespace on first boot
  return open_;
}

sym::StoreResult NvsStore::load_u64(const char* key, uint64_t* out) {
  if (!open_) return sym::StoreResult::kError;
  if (!g_prefs.isKey(key)) return sym::StoreResult::kAbsent;
  *out = g_prefs.getULong64(key, 0);
  return sym::StoreResult::kFound;
}

bool NvsStore::save_u64(const char* key, uint64_t value) {
  if (!open_) return false;
  return g_prefs.putULong64(key, value) == sizeof(uint64_t);
}

bool random_bytes(uint8_t* buf, size_t n) {
  esp_fill_random(buf, n);
  return true;
}

}  // namespace store
