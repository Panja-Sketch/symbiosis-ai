#include "sym_retry.h"

#include <string.h>

namespace sym {

bool extract_error_code(const char* body, char* out, size_t cap) {
  if (body == nullptr || cap == 0) return false;
  const char* key = strstr(body, "\"code\"");
  if (key == nullptr) return false;
  const char* p = key + 6;
  while (*p == ' ' || *p == ':') p++;
  if (*p != '"') return false;
  p++;
  size_t n = 0;
  while (p[n] != '\0' && p[n] != '"') n++;
  if (p[n] != '"' || n == 0 || n + 1 > cap) return false;
  memcpy(out, p, n);
  out[n] = '\0';
  return true;
}

SendOutcome classify_response(int http_status, const char* body) {
  if (http_status <= 0) return SendOutcome::kRetryNetwork;
  if (http_status >= 200 && http_status < 300) return SendOutcome::kOk;
  char code[40];
  bool has_code = extract_error_code(body, code, sizeof(code));
  if (http_status == 401) {
    if (has_code &&
        (strcmp(code, "STALE_TIMESTAMP") == 0 || strcmp(code, "FUTURE_TIMESTAMP") == 0)) {
      return SendOutcome::kClockSkew;
    }
    return SendOutcome::kAuthPermanent;
  }
  if (http_status == 403) return SendOutcome::kForbidden;
  if (http_status == 409) {
    if (has_code && strcmp(code, "NONCE_REPLAY") == 0) return SendOutcome::kNonceCollision;
    return SendOutcome::kSequenceConflict;
  }
  if (http_status == 408 || http_status == 425 || http_status == 429 || http_status >= 500) {
    return SendOutcome::kRetryServer;
  }
  return SendOutcome::kRejectedPayload;
}

bool outcome_latches(SendOutcome o) {
  return o == SendOutcome::kSequenceConflict || o == SendOutcome::kAuthPermanent ||
         o == SendOutcome::kForbidden;
}

uint32_t backoff_ms(uint8_t attempt) {
  uint32_t v = 2000;
  for (uint8_t i = 0; i < attempt && v < 60000; i++) v *= 2;
  return v > 60000 ? 60000 : v;
}

}  // namespace sym
