#include "transport.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <string.h>

#include "ca_certs.h"
#include "config.h"
#include "diag.h"
#include "sym_signing.h"

namespace transport {

Response post(const Request& r) {
  Response out;
  out.status = 0;
  out.body[0] = '\0';

  WiFiClientSecure client;
  client.setCACert(kRootCaPem);  // verify the API certificate chain; no insecure fallback
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);

  char url[160];
  snprintf(url, sizeof(url), "%s%s", SYM_API_BASE_URL, r.path);

  HTTPClient http;
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    out.status = -100;
    return out;
  }
  char num[24];
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", SYM_DEVICE_ID);
  http.addHeader("X-Key-Id", SYM_KEY_ID);
  sym::u64_to_dec(r.timestamp, num, sizeof(num));
  http.addHeader("X-Timestamp", num);
  http.addHeader("X-Nonce", r.nonce);
  sym::u64_to_dec(r.seq, num, sizeof(num));
  http.addHeader("X-Seq", num);
  http.addHeader("X-Signature", r.signature_hex);

  out.status = http.POST(const_cast<uint8_t*>(r.body), r.body_len);
  if (out.status > 0) {
    String payload = http.getString();
    strncpy(out.body, payload.c_str(), sizeof(out.body) - 1);
    out.body[sizeof(out.body) - 1] = '\0';
  }
  http.end();
  return out;
}

}  // namespace transport
