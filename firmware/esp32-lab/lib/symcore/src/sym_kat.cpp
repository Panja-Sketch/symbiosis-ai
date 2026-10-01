#include "sym_kat.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "sym_sha256.h"
#include "sym_signing.h"

namespace sym {

// SYNTHETIC public vector key (not a credential).
const char* const kKatKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const char* const kKatMethod = "POST";
const char* const kKatPath = "/edge/v1/telemetry";
const char* const kKatTimestamp = "1790000000";
const char* const kKatNonce = "vector_nonce_0001";
const char* const kKatSeq = "42";
const char* const kKatBody =
    "{\"device_id\":\"DEV-SIM-001\",\"firmware_version\":\"sim-0.1.0\",\"source\":\"SIMULATOR\","
    "\"batch\":[{\"observed_at\":\"2026-09-29T20:00:00Z\",\"readings\":{\"temperature_c\":4.2,"
    "\"relative_humidity_pct\":55.1,\"vibration_rms_ms2\":0.18,\"current_ma\":312.0,"
    "\"fan_a_load_pct\":100,\"chiller_b_running\":false}}]}";
const char* const kKatBodySha256 =
    "c743552ae5c7e2458fd98e5ea86d46ea16417ada09810e3d0a7bdb81aaabfa1e";
const char* const kKatSigningMaterial =
    "POST\n/edge/v1/telemetry\n1790000000\nvector_nonce_0001\n42\n"
    "c743552ae5c7e2458fd98e5ea86d46ea16417ada09810e3d0a7bdb81aaabfa1e";
const char* const kKatSignature =
    "16de8c3f2d864a673edc272cd4b3182ee66ebe70b380e2aacf85fd7e14b1f025";

static void report(char* detail, size_t cap, const char* stage) {
  if (detail != nullptr && cap > 0) snprintf(detail, cap, "%s", stage);
}

bool signing_self_test(char* detail, size_t cap) {
  uint8_t key[kKeyLen];
  if (!from_hex(kKatKeyHex, kKeyLen, key)) {
    report(detail, cap, "key-parse");
    return false;
  }
  const uint8_t* body = reinterpret_cast<const uint8_t*>(kKatBody);
  const size_t body_len = strlen(kKatBody);

  uint8_t digest[kSha256Len];
  char hash_hex[65];
  sha256(body, body_len, digest);
  to_hex(digest, kSha256Len, hash_hex);
  if (strcmp(hash_hex, kKatBodySha256) != 0) {
    report(detail, cap, "body-hash");
    return false;
  }

  char material[kSigningMaterialMax];
  const uint64_t ts = 1790000000ULL;
  const uint64_t seq = 42ULL;
  size_t n = build_signing_material(material, sizeof(material), kKatMethod, kKatPath, ts,
                                    kKatNonce, seq, hash_hex);
  if (n == 0 || strcmp(material, kKatSigningMaterial) != 0) {
    report(detail, cap, "signing-material");
    return false;
  }

  char body_hash2[65];
  char sig[65];
  if (!sign_request(key, kKatMethod, kKatPath, ts, kKatNonce, seq, body, body_len, body_hash2,
                    sig) ||
      strcmp(sig, kKatSignature) != 0) {
    report(detail, cap, "signature");
    return false;
  }
  report(detail, cap, "ok");
  return true;
}

}  // namespace sym
