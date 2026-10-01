#pragma once
// SHA-256 / HMAC-SHA256 (FIPS 180-4 / RFC 2104). Portable: the same code is exercised by the
// host tests (cross-checked against Node's crypto) and by the on-device known-answer self-test.
#include <stddef.h>
#include <stdint.h>

namespace sym {

constexpr size_t kSha256Len = 32;
constexpr size_t kSha256HexLen = 64;

class Sha256 {
 public:
  Sha256();
  void update(const uint8_t* data, size_t len);
  void finish(uint8_t out[kSha256Len]);

 private:
  void block(const uint8_t* p);
  uint32_t h_[8];
  uint8_t buf_[64];
  uint64_t total_;
  size_t fill_;
};

void sha256(const uint8_t* data, size_t len, uint8_t out[kSha256Len]);
void hmac_sha256(const uint8_t* key, size_t key_len, const uint8_t* msg, size_t msg_len,
                 uint8_t out[kSha256Len]);

/** Lowercase hex, writes 2*n characters plus a NUL terminator. */
void to_hex(const uint8_t* in, size_t n, char* out);
/** Parses exactly 2*n hex characters (either case). Returns false on any invalid input. */
bool from_hex(const char* hex, size_t n, uint8_t* out);

}  // namespace sym
