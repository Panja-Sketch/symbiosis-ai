#pragma once
// HTTPS transport for the signed edge protocol. It sends exactly the bytes it is given (the same
// bytes that were hashed and signed) and only ever READS the response status and error code; the
// response is never interpreted as a command.
#include <stddef.h>
#include <stdint.h>

namespace transport {

struct Request {
  const char* path;  // "/edge/v1/telemetry" or "/edge/v1/heartbeat"
  const uint8_t* body;
  size_t body_len;
  uint64_t timestamp;
  const char* nonce;
  uint64_t seq;
  const char* signature_hex;
};

struct Response {
  int status;  // HTTP status, or <= 0 when no HTTP response was received
  char body[192];
};

Response post(const Request& request);

}  // namespace transport
