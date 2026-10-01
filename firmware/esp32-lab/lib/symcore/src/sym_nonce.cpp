#include "sym_nonce.h"

#include <string.h>

namespace sym {

bool base64url_encode(const uint8_t* in, size_t n, char* out, size_t cap) {
  static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  size_t need = (n / 3) * 4;
  if (n % 3 == 1) need += 2;
  if (n % 3 == 2) need += 3;
  if (cap < need + 1) return false;
  size_t o = 0;
  size_t i = 0;
  while (i + 3 <= n) {
    uint32_t v = (uint32_t(in[i]) << 16) | (uint32_t(in[i + 1]) << 8) | in[i + 2];
    out[o++] = tbl[(v >> 18) & 63];
    out[o++] = tbl[(v >> 12) & 63];
    out[o++] = tbl[(v >> 6) & 63];
    out[o++] = tbl[v & 63];
    i += 3;
  }
  if (n - i == 1) {
    uint32_t v = uint32_t(in[i]) << 16;
    out[o++] = tbl[(v >> 18) & 63];
    out[o++] = tbl[(v >> 12) & 63];
  } else if (n - i == 2) {
    uint32_t v = (uint32_t(in[i]) << 16) | (uint32_t(in[i + 1]) << 8);
    out[o++] = tbl[(v >> 18) & 63];
    out[o++] = tbl[(v >> 12) & 63];
    out[o++] = tbl[(v >> 6) & 63];
  }
  out[o] = '\0';
  return true;
}

bool is_valid_nonce(const char* nonce) {
  if (nonce == nullptr) return false;
  size_t n = strlen(nonce);
  if (n < 16 || n > 64) return false;
  for (size_t i = 0; i < n; i++) {
    char c = nonce[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

NonceGenerator::NonceGenerator(RandomFn rng) : rng_(rng) { last_[0] = '\0'; }

bool NonceGenerator::generate(char* out) {
  for (int attempt = 0; attempt < 4; attempt++) {
    uint8_t rnd[kNonceRandomBytes];
    if (rng_ == nullptr || !rng_(rnd, sizeof(rnd))) return false;
    char candidate[kNonceLen + 1];
    if (!base64url_encode(rnd, sizeof(rnd), candidate, sizeof(candidate))) return false;
    if (!is_valid_nonce(candidate)) return false;
    if (strcmp(candidate, last_) == 0) continue;  // a stuck RNG must never repeat a nonce
    memcpy(last_, candidate, sizeof(last_));
    memcpy(out, candidate, sizeof(candidate));
    return true;
  }
  return false;
}

}  // namespace sym
