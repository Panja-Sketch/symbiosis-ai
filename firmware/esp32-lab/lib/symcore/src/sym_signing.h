#pragma once
// Edge request signing: the S2 contract (packages/edge-security/src/signing.ts).
//   material  = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" SEQ "\n" SHA256_HEX(raw_body)
//   signature = lowercase-hex( HMAC-SHA256( raw 32-byte key, material ) )
// TIMESTAMP is Unix epoch seconds, SEQ a decimal integer, no trailing newline.
#include <stddef.h>
#include <stdint.h>

namespace sym {

constexpr size_t kKeyLen = 32;
constexpr size_t kSigningMaterialMax = 256;
constexpr const char* kPathTelemetry = "/edge/v1/telemetry";
constexpr const char* kPathHeartbeat = "/edge/v1/heartbeat";

/** Decimal rendering of an unsigned 64-bit value; returns characters written (NUL added). */
size_t u64_to_dec(uint64_t v, char* out, size_t cap);

/** Returns the material length (excluding NUL), or 0 if `cap` is too small. */
size_t build_signing_material(char* out, size_t cap, const char* method, const char* path,
                              uint64_t timestamp, const char* nonce, uint64_t seq,
                              const char* body_sha256_hex);

/**
 * Hashes `body` (the exact bytes that will be sent), builds the material and signs it.
 * `body_hash_hex` and `sig_hex` each need 65 bytes. Returns false if the material overflows.
 */
bool sign_request(const uint8_t key[kKeyLen], const char* method, const char* path,
                  uint64_t timestamp, const char* nonce, uint64_t seq, const uint8_t* body,
                  size_t body_len, char body_hash_hex[65], char sig_hex[65]);

}  // namespace sym
