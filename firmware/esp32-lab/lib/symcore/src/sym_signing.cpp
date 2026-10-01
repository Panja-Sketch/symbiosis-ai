#include "sym_signing.h"

#include <string.h>

#include "sym_sha256.h"

namespace sym {

size_t u64_to_dec(uint64_t v, char* out, size_t cap) {
  char tmp[21];
  size_t n = 0;
  do {
    tmp[n++] = char('0' + (v % 10));
    v /= 10;
  } while (v > 0);
  if (n + 1 > cap) return 0;
  for (size_t i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
  out[n] = '\0';
  return n;
}

namespace {
struct Writer {
  char* out;
  size_t cap;
  size_t len;
  bool ok;
  void put(const char* s) {
    size_t n = strlen(s);
    if (len + n + 1 > cap) {
      ok = false;
      return;
    }
    memcpy(out + len, s, n);
    len += n;
    out[len] = '\0';
  }
  void put_upper(const char* s) {
    for (; *s != '\0'; s++) {
      char one[2] = {char((*s >= 'a' && *s <= 'z') ? *s - 32 : *s), '\0'};
      put(one);
    }
  }
  void nl() { put("\n"); }
};
}  // namespace

size_t build_signing_material(char* out, size_t cap, const char* method, const char* path,
                              uint64_t timestamp, const char* nonce, uint64_t seq,
                              const char* body_sha256_hex) {
  if (cap == 0) return 0;
  Writer w = {out, cap, 0, true};
  out[0] = '\0';
  char num[21];
  w.put_upper(method);
  w.nl();
  w.put(path);
  w.nl();
  u64_to_dec(timestamp, num, sizeof(num));
  w.put(num);
  w.nl();
  w.put(nonce);
  w.nl();
  u64_to_dec(seq, num, sizeof(num));
  w.put(num);
  w.nl();
  w.put(body_sha256_hex);  // last line: no trailing newline
  return w.ok ? w.len : 0;
}

bool sign_request(const uint8_t key[kKeyLen], const char* method, const char* path,
                  uint64_t timestamp, const char* nonce, uint64_t seq, const uint8_t* body,
                  size_t body_len, char body_hash_hex[65], char sig_hex[65]) {
  uint8_t digest[kSha256Len];
  sha256(body, body_len, digest);
  to_hex(digest, kSha256Len, body_hash_hex);
  char material[kSigningMaterialMax];
  size_t n = build_signing_material(material, sizeof(material), method, path, timestamp, nonce,
                                    seq, body_hash_hex);
  if (n == 0) return false;
  uint8_t mac[kSha256Len];
  hmac_sha256(key, kKeyLen, reinterpret_cast<const uint8_t*>(material), n, mac);
  to_hex(mac, kSha256Len, sig_hex);
  return true;
}

}  // namespace sym
