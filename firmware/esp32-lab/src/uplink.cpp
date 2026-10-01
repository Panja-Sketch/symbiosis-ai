#include "uplink.h"

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <string.h>

#include "config.h"
#include "diag.h"
#include "net.h"
#include "store.h"
#include "sym_gate.h"
#include "sym_nonce.h"
#include "sym_queue.h"
#include "sym_retry.h"
#include "sym_sequence.h"
#include "sym_sha256.h"
#include "sym_signing.h"
#include "transport.h"

namespace uplink {

namespace {

store::NvsStore g_nvs;
sym::SequenceCounter g_seq(&g_nvs);
sym::NonceGenerator g_nonce(store::random_bytes);
sym::BoundedQueue<sym::Sample, QUEUE_CAPACITY> g_queue;

uint8_t g_key[sym::kKeyLen];
sym::GateState g_gate = {false, false, false, false, false, false};
sym::Block g_last_block = sym::Block::kNone;

uint32_t g_next_attempt_ms = 0;
uint32_t g_last_send_ms = 0;
uint32_t g_last_hb_ms = 0;
bool g_hb_ever_ok = false;
sym::Health g_last_hb_health = sym::Health::kFault;
uint8_t g_attempt = 0;
uint8_t g_clock_skew_retries = 0;
uint8_t g_nonce_retries = 0;

uint32_t g_ok_telemetry = 0;
uint32_t g_ok_heartbeat = 0;
uint32_t g_dropped_batches = 0;
int g_last_status = 0;

char g_body[6144];
SemaphoreHandle_t g_mutex = nullptr;
volatile uint8_t g_health = uint8_t(sym::Health::kFault);

struct Lock {
  Lock() { xSemaphoreTake(g_mutex, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(g_mutex); }
};

#if defined(SYM_CLOUD_REPLAY_PROBE)
bool g_probe_done = false;
#endif

struct Attempt {
  sym::SendOutcome outcome;
  int status;
  char nonce[sym::kNonceLen + 1];
  char signature[65];
  uint64_t seq;
  uint64_t timestamp;
};

/** Signs and sends one body. Sequence, nonce and signing timestamp are made at send time. */
Attempt send_signed(const char* path, const uint8_t* body, size_t len) {
  Attempt a;
  memset(&a, 0, sizeof(a));
  a.outcome = sym::SendOutcome::kRetryNetwork;
  a.timestamp = net::epoch_seconds();
  if (a.timestamp == 0) return a;  // clock lost: never sign a manufactured time
  a.seq = g_seq.next();
  if (a.seq == 0) {
    LOGF("uplink", "sequence could not be persisted; not sending");
    return a;
  }
  if (!g_nonce.generate(a.nonce)) {
    LOGF("uplink", "nonce generation failed; not sending");
    return a;
  }
  char body_hash[65];
  if (!sym::sign_request(g_key, "POST", path, a.timestamp, a.nonce, a.seq, body, len, body_hash,
                         a.signature)) {
    LOGF("uplink", "signing failed; not sending");
    return a;
  }
  transport::Request req = {path, body, len, a.timestamp, a.nonce, a.seq, a.signature};
  transport::Response res = transport::post(req);
  a.status = res.status;
  g_last_status = res.status;
  a.outcome = sym::classify_response(res.status, res.body);
  if (a.outcome != sym::SendOutcome::kOk) {
    char code[40] = "";
    sym::extract_error_code(res.body, code, sizeof(code));
    LOGF("uplink", "%s seq=%llu -> http %d %s", path, (unsigned long long)a.seq, res.status, code);
  }
#if defined(SYM_CLOUD_REPLAY_PROBE)
  if (a.outcome == sym::SendOutcome::kOk && !g_probe_done &&
      strcmp(path, sym::kPathTelemetry) == 0) {
    g_probe_done = true;
    // Intentionally resend the EXACT same signed request: replay protection must reject it.
    transport::Response again = transport::post(req);
    char code[40] = "";
    sym::extract_error_code(again.body, code, sizeof(code));
    const bool pass = again.status == 409;
    LOGF("probe", "REPLAY_PROBE %s: resent identical signed request -> http %d %s (expected 409)",
         pass ? "PASS" : "FAIL", again.status, code);
  }
#endif
  return a;
}

void latch(const char* why) {
  g_gate.latched = true;
  LOGF("uplink", "LATCHED: %s. Telemetry sending stopped; sampling continues. See README recovery.",
       why);
}

/** Applies the outcome. Returns true if the request's payload was consumed (sent or dropped). */
bool handle_outcome(const Attempt& a, uint32_t now_ms, const char* what) {
  switch (a.outcome) {
    case sym::SendOutcome::kOk:
      g_attempt = 0;
      g_clock_skew_retries = 0;
      g_nonce_retries = 0;
      return true;
    case sym::SendOutcome::kRetryNetwork:
    case sym::SendOutcome::kRetryServer:
      g_next_attempt_ms = now_ms + sym::backoff_ms(g_attempt);
      if (g_attempt < 8) g_attempt++;
      return false;
    case sym::SendOutcome::kClockSkew:
      net::request_resync();
      if (++g_clock_skew_retries > MAX_CLOCK_SKEW_RETRIES) {
        latch("repeated clock-skew rejections");
      }
      g_next_attempt_ms = now_ms + sym::backoff_ms(g_attempt);
      if (g_attempt < 8) g_attempt++;
      return false;
    case sym::SendOutcome::kNonceCollision:
      if (++g_nonce_retries > 3) {
        latch("repeated nonce replay answers");
      }
      return false;  // retried immediately with a fresh nonce
    case sym::SendOutcome::kSequenceConflict:
      latch("server rejected the sequence number (reuse/rollback). Do not lower it; reprovision");
      return false;
    case sym::SendOutcome::kAuthPermanent:
      latch("authentication rejected (wrong key / unknown device or key id)");
      return false;
    case sym::SendOutcome::kForbidden:
      latch("device disabled or device id mismatch");
      return false;
    case sym::SendOutcome::kRejectedPayload:
      g_dropped_batches++;
      LOGF("uplink", "%s rejected as malformed (http %d); dropping it", what, a.status);
      return true;
  }
  return false;
}

void do_heartbeat(uint32_t now_ms, sym::Health health) {
  size_t n = sym::serialize_heartbeat(g_body, sizeof(g_body), SYM_DEVICE_ID, SYM_FW_VERSION,
                                      net::epoch_seconds(), health);
  if (n == 0) return;
  Attempt a = send_signed(sym::kPathHeartbeat, reinterpret_cast<const uint8_t*>(g_body), n);
  if (handle_outcome(a, now_ms, "heartbeat")) {
    g_last_hb_ms = now_ms;
    g_last_hb_health = health;
    if (a.outcome == sym::SendOutcome::kOk) {
      g_hb_ever_ok = true;
      g_ok_heartbeat++;
    }
  }
}

void do_telemetry(uint32_t now_ms) {
  sym::Sample batch[MAX_SAMPLES_PER_REQUEST];
  size_t count = 0;
  size_t dropped_before = 0;
  {
    Lock lock;
    count = g_queue.peek(batch, MAX_SAMPLES_PER_REQUEST);
    dropped_before = g_queue.dropped();
  }
  size_t n = 0;
  while (count > 0) {
    n = sym::serialize_telemetry(g_body, sizeof(g_body), SYM_DEVICE_ID, SYM_FW_VERSION, batch, count);
    if (n > 0) break;
    count /= 2;  // body would not fit: send a smaller batch
  }
  if (n == 0) {
    Lock lock;
    g_queue.pop(1);  // unserialisable head sample: discard it rather than block the queue
    g_dropped_batches++;
    return;
  }
  Attempt a = send_signed(sym::kPathTelemetry, reinterpret_cast<const uint8_t*>(g_body), n);
  if (handle_outcome(a, now_ms, "telemetry")) {
    {
      Lock lock;
      // If the queue overflowed while sending, the oldest samples (part of this batch) are gone.
      const size_t overflowed = g_queue.dropped() - dropped_before;
      if (count > overflowed) g_queue.pop(count - overflowed);
    }
    g_last_send_ms = now_ms;
    if (a.outcome == sym::SendOutcome::kOk) {
      g_ok_telemetry++;
      LOGF("uplink", "telemetry ok: %u sample(s), seq=%llu", unsigned(count),
           (unsigned long long)a.seq);
    }
  }
}

}  // namespace

static void service(uint32_t now_ms, sym::Health health);

static void task_main(void*) {
  for (;;) {
    const uint32_t now_ms = millis();
    net::service(now_ms);
    service(now_ms, static_cast<sym::Health>(g_health));
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

bool begin(bool kat_passed) {
  g_gate.kat_passed = kat_passed;
  g_gate.key_loaded = false;
#if defined(SYM_SECRETS_ARE_PLACEHOLDER)
  LOGF("uplink", "secrets.h is the placeholder template: sending is disabled");
#else
  if (!sym::is_safe_token(SYM_DEVICE_ID) || !sym::is_safe_token(SYM_KEY_ID)) {
    LOGF("uplink", "DEVICE_ID/KEY_ID contain unsupported characters");
  } else if (strlen(SYM_DEVICE_KEY_HEX) != 64 || !sym::from_hex(SYM_DEVICE_KEY_HEX, 32, g_key)) {
    LOGF("uplink", "device key is not 64 hex characters");
  } else {
    uint8_t acc = 0;
    for (size_t i = 0; i < sizeof(g_key); i++) acc |= g_key[i];
    g_gate.key_loaded = acc != 0;  // an all-zero key is the template value
    if (!g_gate.key_loaded) LOGF("uplink", "device key is all zero (template value)");
  }
#endif
  if (strncmp(SYM_API_BASE_URL, "https://", 8) != 0 ||
      SYM_API_BASE_URL[strlen(SYM_API_BASE_URL) - 1] == '/') {
    LOGF("uplink", "API base URL must be https://host with no trailing slash");
    g_gate.key_loaded = false;
  }
  if (!g_nvs.open()) {
    LOGF("uplink", "NVS open failed: sequence cannot be persisted, sending disabled");
    return false;
  }
  g_mutex = xSemaphoreCreateMutex();
  // HTTPS calls block for seconds; they run on their own task so input polling never stalls.
  xTaskCreatePinnedToCore(task_main, "uplink", 12288, nullptr, 1, nullptr, 0);
  return g_gate.key_loaded && g_gate.kat_passed;
}

void enqueue(const sym::Sample& sample) {
  Lock lock;
  g_queue.push(sample);
}

void set_health(sym::Health health) { g_health = uint8_t(health); }

bool latched() { return g_gate.latched; }

static void service(uint32_t now_ms, sym::Health health) {
  g_gate.wifi_up = net::wifi_up();
  g_gate.time_synced = net::time_synced();
  if (!g_gate.sequence_ready && g_gate.time_synced) {
    // First start (or erased flash) seeds from trusted time; otherwise resumes the reservation.
    g_gate.sequence_ready = g_seq.begin(net::epoch_seconds());
    if (!g_gate.sequence_ready) LOGF("uplink", "sequence counter failed to start (NVS error)");
  }
  const sym::Block block = sym::send_block_reason(g_gate);
  if (block != g_last_block) {
    LOGF("uplink", "send gate: %s", sym::block_name(block));
    g_last_block = block;
  }
  if (block != sym::Block::kNone) return;
  if (int32_t(now_ms - g_next_attempt_ms) < 0) return;

  const bool hb_due = !g_hb_ever_ok || health != g_last_hb_health ||
                      uint32_t(now_ms - g_last_hb_ms) >= HEARTBEAT_INTERVAL_MS;
  if (hb_due) {
    do_heartbeat(now_ms, health);
    return;
  }
  size_t queued = 0;
  {
    Lock lock;
    queued = g_queue.size();
  }
  if (queued == 0) return;
  const bool due = uint32_t(now_ms - g_last_send_ms) >= SEND_INTERVAL_MS ||
                   queued >= MAX_SAMPLES_PER_REQUEST;
  if (due) do_telemetry(now_ms);
}

void print_status() {
  Lock lock;
  LOGF("status", "gate=%s queue=%u dropped_oldest=%u ok_telemetry=%u ok_heartbeat=%u dropped_batches=%u last_http=%d",
       sym::block_name(sym::send_block_reason(g_gate)), unsigned(g_queue.size()),
       unsigned(g_queue.dropped()), unsigned(g_ok_telemetry), unsigned(g_ok_heartbeat),
       unsigned(g_dropped_batches), g_last_status);
}

}  // namespace uplink
