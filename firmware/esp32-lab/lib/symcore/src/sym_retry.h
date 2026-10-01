#pragma once
// Classifies an edge API answer (apps/api/src/edge-handler.ts status mapping) into what the
// firmware does next. Permanent authentication/replay failures are NEVER retried blindly, and a
// sequence conflict never makes the firmware lower its sequence (operator recovery, see docs).
#include <stddef.h>
#include <stdint.h>

namespace sym {

enum class SendOutcome : uint8_t {
  kOk,                // 2xx: accepted
  kRetryNetwork,      // no HTTP answer (Wi-Fi, TLS, timeout)
  kRetryServer,       // 5xx / 408 / 425 / 429: transient, back off and retry the same batch
  kClockSkew,         // 401 STALE/FUTURE_TIMESTAMP: resynchronise time, then retry
  kNonceCollision,    // 409 NONCE_REPLAY: retry once with a fresh nonce
  kSequenceConflict,  // 409 SEQUENCE_REUSE/ROLLBACK: stop and wait for the operator
  kAuthPermanent,     // 401 other: wrong key / unknown device or key id: stop
  kForbidden,         // 403: device disabled or id mismatch: stop
  kRejectedPayload,   // 400 and other 4xx: this batch can never succeed, drop it
};

/** Pulls "code":"..." out of the API's JSON error body. Returns false if there is none. */
bool extract_error_code(const char* body, char* out, size_t cap);

/** `http_status` <= 0 means no HTTP response was received. */
SendOutcome classify_response(int http_status, const char* body);

/** True for outcomes that stop all telemetry until the device is reprovisioned/rebooted. */
bool outcome_latches(SendOutcome o);

/** Exponential backoff: 2 s, 4 s, ... capped at 60 s (attempt 0 = first failure). */
uint32_t backoff_ms(uint8_t attempt);

}  // namespace sym
