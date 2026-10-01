#pragma once
// Nonces must match ^[A-Za-z0-9_-]{16,64}$ (packages/edge-security/src/authenticate.ts).
// 18 random bytes -> 24 base64url characters (no padding).
#include <stddef.h>
#include <stdint.h>

namespace sym {

constexpr size_t kNonceRandomBytes = 18;
constexpr size_t kNonceLen = 24;

typedef bool (*RandomFn)(uint8_t* buf, size_t n);

bool base64url_encode(const uint8_t* in, size_t n, char* out, size_t cap);
bool is_valid_nonce(const char* nonce);

class NonceGenerator {
 public:
  explicit NonceGenerator(RandomFn rng);
  /** `out` needs kNonceLen+1 bytes. Never returns the previously returned nonce. */
  bool generate(char* out);

 private:
  RandomFn rng_;
  char last_[kNonceLen + 1];
};

}  // namespace sym
