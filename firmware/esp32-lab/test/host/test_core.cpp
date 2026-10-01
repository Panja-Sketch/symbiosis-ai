// Host-side tests for the hardware-independent firmware core (lib/symcore).
// Build and run with: node firmware/esp32-lab/test/host/run.mjs
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <map>
#include <string>
#include <vector>

#include "sym_convert.h"
#include "sym_debounce.h"
#include "sym_gate.h"
#include "sym_health.h"
#include "sym_kat.h"
#include "sym_nonce.h"
#include "sym_payload.h"
#include "sym_queue.h"
#include "sym_retry.h"
#include "sym_sequence.h"
#include "sym_sha256.h"
#include "sym_signing.h"
#include "sym_vibration.h"

using namespace sym;

static int g_checks = 0;
static int g_failures = 0;
static const char* g_current = "";

#define CHECK(cond)                                                              \
  do {                                                                           \
    g_checks++;                                                                  \
    if (!(cond)) {                                                               \
      g_failures++;                                                              \
      printf("  FAIL [%s] %s:%d: %s\n", g_current, __FILE__, __LINE__, #cond);   \
    }                                                                            \
  } while (0)

#define CHECK_STR(actual, expected)                                                           \
  do {                                                                                        \
    g_checks++;                                                                               \
    if (strcmp((actual), (expected)) != 0) {                                                  \
      g_failures++;                                                                           \
      printf("  FAIL [%s] %s:%d\n    actual:   %s\n    expected: %s\n", g_current, __FILE__, \
             __LINE__, (actual), (expected));                                                 \
    }                                                                                         \
  } while (0)

#define TEST(name)                       \
  static void name();                    \
  struct Reg_##name {                    \
    Reg_##name() { registry().push_back({#name, name}); } \
  } reg_##name;                          \
  static void name()

struct Entry {
  const char* name;
  void (*fn)();
};
static std::vector<Entry>& registry() {
  static std::vector<Entry> r;
  return r;
}

static std::string g_repo_root = ".";

static std::string read_file(const std::string& path) {
  FILE* f = fopen(path.c_str(), "rb");
  if (f == nullptr) return std::string("\x01<missing>");
  std::string out;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  fclose(f);
  return out;
}

// Extracts a simple "key": "value" string from the vector JSON (values have no escapes except \n).
static std::string json_string(const std::string& json, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t k = json.find(needle);
  if (k == std::string::npos) return "<none>";
  size_t q = json.find('"', json.find(':', k) + 1);
  std::string out;
  for (size_t i = q + 1; i < json.size() && json[i] != '"'; i++) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      i++;
      out += (json[i] == 'n') ? '\n' : json[i];
    } else {
      out += json[i];
    }
  }
  return out;
}

static std::string hex(const uint8_t* p, size_t n) {
  std::vector<char> b(n * 2 + 1);
  to_hex(p, n, b.data());
  return std::string(b.data());
}

// ---------------------------------------------------------------------------------------------
TEST(sha256_and_hmac_standard_vectors) {
  uint8_t d[32];
  sha256(reinterpret_cast<const uint8_t*>("abc"), 3, d);
  CHECK_STR(hex(d, 32).c_str(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  sha256(nullptr, 0, d);
  CHECK_STR(hex(d, 32).c_str(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  // RFC 4231 test case 1 and 2.
  uint8_t key1[20];
  memset(key1, 0x0b, sizeof(key1));
  hmac_sha256(key1, 20, reinterpret_cast<const uint8_t*>("Hi There"), 8, d);
  CHECK_STR(hex(d, 32).c_str(), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  const char* msg = "what do ya want for nothing?";
  hmac_sha256(reinterpret_cast<const uint8_t*>("Jefe"), 4, reinterpret_cast<const uint8_t*>(msg),
              strlen(msg), d);
  CHECK_STR(hex(d, 32).c_str(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

TEST(sha256_incremental_equals_one_shot_across_block_boundaries) {
  std::vector<uint8_t> data(300);
  for (size_t i = 0; i < data.size(); i++) data[i] = uint8_t(i * 7 + 3);
  for (size_t len : {0u, 1u, 55u, 56u, 63u, 64u, 65u, 119u, 120u, 128u, 300u}) {
    uint8_t a[32], b[32];
    sha256(data.data(), len, a);
    Sha256 s;
    size_t off = 0;
    while (off < len) {
      size_t take = (off % 5) + 1;
      if (off + take > len) take = len - off;
      s.update(data.data() + off, take);
      off += take;
    }
    s.finish(b);
    CHECK(memcmp(a, b, 32) == 0);
  }
}

TEST(s2_known_answer_vector_matches_repository_fixture_byte_for_byte) {
  std::string vec = read_file(g_repo_root + "/firmware-contracts/sample-packets/signing-vector.json");
  std::string body = read_file(g_repo_root + "/firmware-contracts/sample-packets/telemetry.sample.json");
  CHECK(vec.find("<missing>") == std::string::npos);
  CHECK_STR(kKatKeyHex, json_string(vec, "device_key_hex").c_str());
  CHECK_STR(kKatMethod, json_string(vec, "method").c_str());
  CHECK_STR(kKatPath, json_string(vec, "path").c_str());
  CHECK_STR(kKatTimestamp, json_string(vec, "x_timestamp").c_str());
  CHECK_STR(kKatNonce, json_string(vec, "x_nonce").c_str());
  CHECK_STR(kKatSeq, json_string(vec, "x_seq").c_str());
  CHECK_STR(kKatBodySha256, json_string(vec, "body_sha256").c_str());
  CHECK_STR(kKatSigningMaterial, json_string(vec, "signing_material").c_str());
  CHECK_STR(kKatSignature, json_string(vec, "x_signature").c_str());
  CHECK(body == std::string(kKatBody));  // exact bytes, no trailing newline
}

TEST(firmware_signing_self_test_passes_and_reproduces_vector) {
  char detail[32];
  CHECK(signing_self_test(detail, sizeof(detail)));
  CHECK_STR(detail, "ok");
}

TEST(signing_material_has_exact_line_order_and_no_trailing_newline) {
  char m[kSigningMaterialMax];
  size_t n = build_signing_material(m, sizeof(m), "post", "/edge/v1/telemetry", 1790000000ULL,
                                    "vector_nonce_0001", 42ULL, "aa");
  CHECK(n > 0);
  CHECK_STR(m, "POST\n/edge/v1/telemetry\n1790000000\nvector_nonce_0001\n42\naa");
  CHECK(m[n - 1] != '\n');
  char small[8];
  CHECK(build_signing_material(small, sizeof(small), "POST", "/edge/v1/telemetry", 1, "n", 1, "a") == 0);
}

TEST(signature_depends_on_every_signed_component) {
  uint8_t key[32];
  from_hex(kKatKeyHex, 32, key);
  const uint8_t* body = reinterpret_cast<const uint8_t*>(kKatBody);
  size_t len = strlen(kKatBody);
  char h[65], base[65], s[65];
  CHECK(sign_request(key, "POST", "/edge/v1/telemetry", 1790000000ULL, "vector_nonce_0001", 42, body, len, h, base));
  CHECK(sign_request(key, "POST", "/edge/v1/telemetry", 1790000001ULL, "vector_nonce_0001", 42, body, len, h, s));
  CHECK(strcmp(base, s) != 0);
  CHECK(sign_request(key, "POST", "/edge/v1/telemetry", 1790000000ULL, "vector_nonce_0002", 42, body, len, h, s));
  CHECK(strcmp(base, s) != 0);
  CHECK(sign_request(key, "POST", "/edge/v1/telemetry", 1790000000ULL, "vector_nonce_0001", 43, body, len, h, s));
  CHECK(strcmp(base, s) != 0);
  CHECK(sign_request(key, "POST", "/edge/v1/heartbeat", 1790000000ULL, "vector_nonce_0001", 42, body, len, h, s));
  CHECK(strcmp(base, s) != 0);
  CHECK(sign_request(key, "POST", "/edge/v1/telemetry", 1790000000ULL, "vector_nonce_0001", 42, body, len - 1, h, s));
  CHECK(strcmp(base, s) != 0);
}

// ---------------------------------------------------------------------------------------------
static uint64_t g_rng_state = 0x9E3779B97F4A7C15ULL;
static bool counter_rng(uint8_t* buf, size_t n) {  // splitmix64: deterministic test entropy
  for (size_t i = 0; i < n; i++) {
    g_rng_state += 0x9E3779B97F4A7C15ULL;
    uint64_t z = g_rng_state;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    buf[i] = uint8_t((z ^ (z >> 31)) & 0xff);
  }
  return true;
}
static bool stuck_rng(uint8_t* buf, size_t n) {
  memset(buf, 0x42, n);
  return true;
}
static bool failing_rng(uint8_t*, size_t) { return false; }

TEST(nonce_format_matches_s2_parser_and_is_unique) {
  NonceGenerator gen(counter_rng);
  std::map<std::string, int> seen;
  for (int i = 0; i < 2000; i++) {
    char n[kNonceLen + 1];
    CHECK(gen.generate(n));
    CHECK(strlen(n) == kNonceLen);
    CHECK(is_valid_nonce(n));
    CHECK(seen.find(n) == seen.end());
    seen[n] = 1;
  }
  CHECK(!is_valid_nonce("short"));
  CHECK(!is_valid_nonce("has+plus/and=pad======"));
  CHECK(!is_valid_nonce("0123456789abcdef"  "0123456789abcdef" "0123456789abcdef" "0123456789abcdef" "x"));
}

TEST(nonce_generator_never_repeats_even_with_a_stuck_rng) {
  NonceGenerator gen(stuck_rng);
  char a[kNonceLen + 1];
  char b[kNonceLen + 1];
  CHECK(gen.generate(a));
  CHECK(!gen.generate(b));  // refuses rather than reuse a nonce
  NonceGenerator bad(failing_rng);
  CHECK(!bad.generate(a));
}

TEST(base64url_uses_url_safe_alphabet_without_padding) {
  const uint8_t in[3] = {0xfb, 0xff, 0xfe};
  char out[8];
  CHECK(base64url_encode(in, 3, out, sizeof(out)));
  CHECK_STR(out, "-__-");
  CHECK(base64url_encode(in, 1, out, sizeof(out)));
  CHECK_STR(out, "-w");
}

// ---------------------------------------------------------------------------------------------
class FakeStore : public KeyValueStore {
 public:
  std::map<std::string, uint64_t> data;
  bool fail_load = false;
  bool fail_save = false;
  int saves = 0;
  StoreResult load_u64(const char* key, uint64_t* out) override {
    if (fail_load) return StoreResult::kError;
    auto it = data.find(key);
    if (it == data.end()) return StoreResult::kAbsent;
    *out = it->second;
    return StoreResult::kFound;
  }
  bool save_u64(const char* key, uint64_t value) override {
    if (fail_save) return false;
    data[key] = value;
    saves++;
    return true;
  }
};

TEST(sequence_survives_simulated_reboots_and_never_goes_down) {
  FakeStore store;  // plays the role of NVS flash across power cycles
  uint64_t last = 0;
  for (int boot = 0; boot < 6; boot++) {
    SequenceCounter c(&store);  // a reboot constructs a fresh counter on the same flash
    CHECK(c.begin(1790000000ULL));
    int requests = 5 + boot * 37;  // crosses reservation blocks
    for (int i = 0; i < requests; i++) {
      uint64_t s = c.next();
      CHECK(s > last);
      last = s;
    }
  }
}

TEST(sequence_resumes_above_a_reservation_after_unclean_reset) {
  FakeStore store;
  SequenceCounter first(&store);
  CHECK(first.begin(1790000000ULL));
  uint64_t used = 0;
  for (int i = 0; i < 10; i++) used = first.next();
  SequenceCounter second(&store);  // power loss: no shutdown hook ran
  CHECK(second.begin(1ULL));
  CHECK(second.next() > used);
}

TEST(sequence_is_seeded_from_trusted_time_only_when_flash_is_empty) {
  FakeStore store;
  SequenceCounter c(&store);
  CHECK(c.begin(1790000000ULL));
  CHECK(c.next() == 1790000001ULL);
  SequenceCounter again(&store);
  CHECK(again.begin(1790999999ULL));  // flash has a value: the seed is ignored
  CHECK(again.next() < 1790000100ULL);
}

TEST(sequence_refuses_to_start_from_zero_or_without_persistence) {
  FakeStore broken;
  broken.fail_load = true;
  SequenceCounter a(&broken);
  CHECK(!a.begin(1790000000ULL));
  CHECK(a.next() == 0);
  FakeStore empty;
  SequenceCounter b(&empty);
  CHECK(!b.begin(0));  // no trusted time and no stored value
  FakeStore nosave;
  SequenceCounter c(&nosave);
  CHECK(c.begin(1790000000ULL));
  nosave.fail_save = true;
  uint64_t got = 0;
  for (int i = 0; i < 200 && got == 0; i++) {
    uint64_t s = c.next();
    if (s == 0) got = 1;
  }
  CHECK(got == 1);  // cannot persist a new block: refuses to hand out sequence numbers
}

TEST(sequence_writes_flash_once_per_block_not_per_request) {
  FakeStore store;
  SequenceCounter c(&store);
  CHECK(c.begin(1790000000ULL));
  int before = store.saves;
  for (uint64_t i = 0; i < kSeqBlock * 3; i++) c.next();
  CHECK(store.saves - before <= 4);
}

// ---------------------------------------------------------------------------------------------
static Sample full_sample(uint64_t epoch) {
  Sample s;
  memset(&s, 0, sizeof(s));
  s.epoch_s = epoch;
  s.has_temperature = s.has_humidity = s.has_vibration = s.has_current = s.has_fan_b = true;
  s.temperature_c = 4.2f;
  s.relative_humidity_pct = 55.1f;
  s.vibration_rms_ms2 = 0.18f;
  s.current_ma = 312.0f;
  s.fan_b_running = false;
  return s;
}

TEST(iso8601_formatting_is_utc_and_calendar_correct) {
  char b[24];
  CHECK(format_iso8601(0, b, sizeof(b)) == 20);
  CHECK_STR(b, "1970-01-01T00:00:00Z");
  format_iso8601(951782400ULL, b, sizeof(b));
  CHECK_STR(b, "2000-02-29T00:00:00Z");
  format_iso8601(1709164800ULL, b, sizeof(b));
  CHECK_STR(b, "2024-02-29T00:00:00Z");
  format_iso8601(1767225599ULL, b, sizeof(b));
  CHECK_STR(b, "2025-12-31T23:59:59Z");
  format_iso8601(4102444800ULL, b, sizeof(b));
  CHECK_STR(b, "2100-01-01T00:00:00Z");
  CHECK(format_iso8601(0, b, 5) == 0);
}

TEST(telemetry_body_matches_the_canonical_edge_v1_shape_exactly) {
  Sample s = full_sample(1767225599ULL);
  char body[512];
  size_t n = serialize_telemetry(body, sizeof(body), "DEV-PHX-BENCH-001", "0.1.0+gabc1234", &s, 1);
  CHECK(n > 0);
  CHECK_STR(body,
            "{\"device_id\":\"DEV-PHX-BENCH-001\",\"firmware_version\":\"0.1.0+gabc1234\","
            "\"source\":\"HARDWARE\",\"batch\":[{\"observed_at\":\"2025-12-31T23:59:59Z\","
            "\"readings\":{\"temperature_c\":4.20,\"relative_humidity_pct\":55.1,"
            "\"vibration_rms_ms2\":0.1800,\"current_ma\":312.0,\"chiller_b_running\":false}}]}");
  CHECK(strstr(body, "fan_a_load_pct") == nullptr);  // not measured, never sent
  CHECK(strstr(body, "SIMULATOR") == nullptr);        // hardware is never labelled synthetic
}

TEST(unavailable_readings_are_omitted_and_never_invented) {
  Sample s = full_sample(1767225599ULL);
  s.has_temperature = false;
  s.has_humidity = false;
  s.vibration_rms_ms2 = NAN;  // flag set but value not finite: must not be emitted
  s.has_current = false;
  s.fan_b_running = true;
  char body[512];
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1.0", &s, 1) > 0);
  CHECK(strstr(body, "vibration_rms_ms2") == nullptr);  // non-finite is never emitted
  Sample t = full_sample(1767225599ULL);
  t.has_temperature = t.has_humidity = t.has_current = t.has_vibration = false;
  t.fan_b_running = true;
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1.0", &t, 1) > 0);
  CHECK(strstr(body, "temperature_c") == nullptr);
  CHECK(strstr(body, "current_ma") == nullptr);
  CHECK(strstr(body, "\"chiller_b_running\":true") != nullptr);
  Sample none;
  memset(&none, 0, sizeof(none));
  none.epoch_s = 1767225599ULL;
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1.0", &none, 1) == 0);
}

TEST(batch_preserves_order_and_original_observation_times) {
  Sample b[3] = {full_sample(1767225590ULL), full_sample(1767225595ULL), full_sample(1767225600ULL)};
  char body[1024];
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1.0", b, 3) > 0);
  const char* a = strstr(body, "2025-12-31T23:59:50Z");
  const char* m = strstr(body, "2025-12-31T23:59:55Z");
  const char* c = strstr(body, "2026-01-01T00:00:00Z");
  CHECK(a != nullptr && m != nullptr && c != nullptr && a < m && m < c);
}

TEST(identity_strings_are_restricted_and_overflow_is_reported) {
  Sample s = full_sample(1767225599ULL);
  char body[512];
  CHECK(serialize_telemetry(body, sizeof(body), "DEV\"X", "1.0", &s, 1) == 0);
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1 0", &s, 1) == 0);
  CHECK(serialize_telemetry(body, 40, "DEV-X", "1.0", &s, 1) == 0);
  CHECK(serialize_telemetry(body, sizeof(body), "DEV-X", "1.0", &s, 0) == 0);
}

TEST(heartbeat_body_matches_the_contract) {
  char body[256];
  size_t n = serialize_heartbeat(body, sizeof(body), "DEV-X", "1.0", 1767225599ULL, Health::kDegraded);
  CHECK(n > 0);
  CHECK_STR(body,
            "{\"device_id\":\"DEV-X\",\"firmware_version\":\"1.0\",\"sent_at\":\"2025-12-31T23:59:59Z\","
            "\"health\":\"DEGRADED\"}");
}

// ---------------------------------------------------------------------------------------------
TEST(queue_is_bounded_drops_oldest_and_keeps_order) {
  BoundedQueue<int, 4> q;
  for (int i = 1; i <= 6; i++) q.push(i);
  CHECK(q.size() == 4);
  CHECK(q.dropped() == 2);
  int out[8];
  size_t n = q.peek(out, 8);
  CHECK(n == 4);
  CHECK(out[0] == 3 && out[1] == 4 && out[2] == 5 && out[3] == 6);
  q.pop(2);
  q.push(7);
  n = q.peek(out, 2);
  CHECK(n == 2 && out[0] == 5 && out[1] == 6);
  q.pop(99);
  CHECK(q.empty());
}

TEST(retry_classification_distinguishes_network_server_auth_replay_and_schema) {
  CHECK(classify_response(0, "") == SendOutcome::kRetryNetwork);
  CHECK(classify_response(-1, "") == SendOutcome::kRetryNetwork);
  CHECK(classify_response(202, "") == SendOutcome::kOk);
  CHECK(classify_response(200, "") == SendOutcome::kOk);
  CHECK(classify_response(500, "") == SendOutcome::kRetryServer);
  CHECK(classify_response(503, "") == SendOutcome::kRetryServer);
  CHECK(classify_response(429, "") == SendOutcome::kRetryServer);
  CHECK(classify_response(401, "{\"error\":{\"code\":\"STALE_TIMESTAMP\",\"message\":\"x\"}}") == SendOutcome::kClockSkew);
  CHECK(classify_response(401, "{\"error\":{\"code\":\"FUTURE_TIMESTAMP\"}}") == SendOutcome::kClockSkew);
  CHECK(classify_response(401, "{\"error\":{\"code\":\"SIGNATURE_MISMATCH\"}}") == SendOutcome::kAuthPermanent);
  CHECK(classify_response(401, "") == SendOutcome::kAuthPermanent);
  CHECK(classify_response(403, "{\"error\":{\"code\":\"DEVICE_DISABLED\"}}") == SendOutcome::kForbidden);
  CHECK(classify_response(409, "{\"error\":{\"code\":\"NONCE_REPLAY\"}}") == SendOutcome::kNonceCollision);
  CHECK(classify_response(409, "{\"error\":{\"code\":\"SEQUENCE_ROLLBACK\"}}") == SendOutcome::kSequenceConflict);
  CHECK(classify_response(409, "{\"error\":{\"code\":\"SEQUENCE_REUSE\"}}") == SendOutcome::kSequenceConflict);
  CHECK(classify_response(409, "") == SendOutcome::kSequenceConflict);  // unknown 409: fail safe
  CHECK(classify_response(400, "{\"error\":{\"code\":\"INVALID_PAYLOAD\"}}") == SendOutcome::kRejectedPayload);
  CHECK(classify_response(404, "") == SendOutcome::kRejectedPayload);
  CHECK(outcome_latches(SendOutcome::kSequenceConflict));
  CHECK(outcome_latches(SendOutcome::kAuthPermanent));
  CHECK(outcome_latches(SendOutcome::kForbidden));
  CHECK(!outcome_latches(SendOutcome::kRetryServer));
  CHECK(!outcome_latches(SendOutcome::kRejectedPayload));
}

TEST(backoff_is_exponential_and_capped) {
  CHECK(backoff_ms(0) == 2000);
  CHECK(backoff_ms(1) == 4000);
  CHECK(backoff_ms(2) == 8000);
  CHECK(backoff_ms(4) == 32000);
  CHECK(backoff_ms(5) == 60000);
  CHECK(backoff_ms(200) == 60000);
}

// ---------------------------------------------------------------------------------------------
TEST(health_never_claims_healthy_when_a_required_sensor_failed) {
  CHECK(evaluate_health({true, true, true}) == Health::kHealthy);
  CHECK(evaluate_health({false, true, true}) == Health::kDegraded);
  CHECK(evaluate_health({true, false, true}) == Health::kFault);
  CHECK(evaluate_health({true, true, false}) == Health::kFault);
  CHECK(evaluate_health({false, false, false}) == Health::kFault);
  CHECK_STR(health_name(Health::kHealthy), "HEALTHY");
  CHECK_STR(health_name(Health::kFault), "FAULT");
}

TEST(sensor_tracker_follows_init_and_runtime_failures) {
  SensorTracker t;
  CHECK(evaluate_health(t.status()) == Health::kFault);  // nothing initialised
  t.set_init(SensorId::kSht41, true);
  t.set_init(SensorId::kMpu6050, true);
  t.set_init(SensorId::kIna219, true);
  CHECK(evaluate_health(t.status()) == Health::kHealthy);
  t.report_read(SensorId::kIna219, false);
  t.report_read(SensorId::kIna219, false);
  CHECK(evaluate_health(t.status()) == Health::kHealthy);  // tolerates a glitch
  t.report_read(SensorId::kIna219, false);
  CHECK(evaluate_health(t.status()) == Health::kFault);
  t.report_read(SensorId::kIna219, true);
  CHECK(evaluate_health(t.status()) == Health::kHealthy);
  t.set_init(SensorId::kMpu6050, false);
  CHECK(evaluate_health(t.status()) == Health::kFault);
}

TEST(send_gate_blocks_until_every_precondition_holds) {
  GateState g = {true, true, true, true, true, false};
  CHECK(send_block_reason(g) == Block::kNone);
  GateState a = g; a.time_synced = false;
  CHECK(send_block_reason(a) == Block::kNoTime);  // no signed telemetry before clock sync
  GateState b = g; b.kat_passed = false;
  CHECK(send_block_reason(b) == Block::kKatFailed);
  GateState c = g; c.wifi_up = false;
  CHECK(send_block_reason(c) == Block::kNoWifi);
  GateState d = g; d.sequence_ready = false;
  CHECK(send_block_reason(d) == Block::kNoSequence);
  GateState e = g; e.latched = true;
  CHECK(send_block_reason(e) == Block::kLatched);
  GateState f = g; f.key_loaded = false;
  CHECK(send_block_reason(f) == Block::kNoKey);
}

// ---------------------------------------------------------------------------------------------
TEST(vibration_removes_gravity_and_dc_offset) {
  VibrationAccumulator v;
  for (int i = 0; i < 512; i++) v.add(120, -340, 8192);  // tilted, perfectly still
  float rms = -1;
  CHECK(v.rms_ms2(kMpuLsbPerG4g, &rms));
  CHECK(rms == 0.0f);
}

TEST(vibration_rms_is_exact_for_a_known_pattern) {
  VibrationAccumulator v;
  // x alternates +/-819 around a gravity offset on z: AC rms per axis x = 819 counts, others 0.
  for (int i = 0; i < 512; i++) v.add(i % 2 ? 819 : -819, 0, 8192);
  float rms = 0;
  CHECK(v.rms_ms2(kMpuLsbPerG4g, &rms));
  float expected = 819.0f / kMpuLsbPerG4g * kStandardGravity;  // ~0.98 m/s2
  CHECK(fabsf(rms - expected) < 1e-4f);
  VibrationAccumulator one;
  one.add(1, 2, 3);
  CHECK(!one.rms_ms2(kMpuLsbPerG4g, &rms));
}

TEST(vibration_metric_separates_fault_off_from_fault_on) {
  VibrationAccumulator quiet, shaking;
  uint32_t seed = 12345;
  auto rnd = [&seed](int amp) {
    seed = seed * 1664525u + 1013904223u;
    return int16_t(int((seed >> 16) % uint32_t(2 * amp + 1)) - amp);
  };
  for (int i = 0; i < 512; i++) {
    quiet.add(int16_t(rnd(12)), int16_t(rnd(12)), int16_t(8192 + rnd(14)));
    shaking.add(int16_t(rnd(700)), int16_t(rnd(700)), int16_t(8192 + rnd(900)));
  }
  float q = 0, s = 0;
  CHECK(quiet.rms_ms2(kMpuLsbPerG4g, &q));
  CHECK(shaking.rms_ms2(kMpuLsbPerG4g, &s));
  CHECK(s > 10.0f * q);
}

TEST(sensor_conversions_match_datasheet_examples) {
  CHECK(sensirion_crc8(0xBE, 0xEF) == 0x92);  // Sensirion datasheet example
  uint8_t raw[6] = {0x66, 0x66, 0, 0x80, 0x00, 0};
  raw[2] = sensirion_crc8(raw[0], raw[1]);
  raw[5] = sensirion_crc8(raw[3], raw[4]);
  float t = 0, rh = 0;
  CHECK(sht4x_decode(raw, &t, &rh));
  CHECK(fabsf(t - 25.0f) < 0.01f);
  CHECK(fabsf(rh - 56.5f) < 0.05f);
  raw[2] ^= 0x01;  // corrupt CRC
  CHECK(!sht4x_decode(raw, &t, &rh));
  CHECK(fabsf(ina219_shunt_to_ma(1000, 0.1f) - 100.0f) < 0.001f);   // 10 mV across 0.1 ohm = 100 mA
  CHECK(fabsf(ina219_shunt_to_ma(-250, 0.1f) + 25.0f) < 0.001f);
  CHECK(fabsf(ina219_bus_to_v(uint16_t(1250 << 3)) - 5.0f) < 0.001f);
  CHECK(be16(0xff, 0xfe) == -2);
}

TEST(debouncer_ignores_contact_bounce_and_reports_one_change) {
  Debouncer d(30);
  d.reset(false, 0);
  int changes = 0;
  uint32_t t = 100;
  // bounce: 1 0 1 0 1 within 10 ms, then settles at 1
  bool pattern[] = {true, false, true, false, true};
  for (bool b : pattern) {
    changes += d.update(b, t);
    t += 2;
  }
  CHECK(changes == 0);
  CHECK(!d.stable());
  for (int i = 0; i < 20; i++) {
    changes += d.update(true, t);
    t += 5;
  }
  CHECK(changes == 1);
  CHECK(d.stable());
  // wrap-around of the millisecond counter
  Debouncer w(30);
  w.reset(false, 0xFFFFFFF0u);
  bool changed = false;
  uint32_t tw = 0xFFFFFFF0u;
  for (int i = 0; i < 20; i++) {
    changed |= w.update(true, tw);
    tw += 5;
  }
  CHECK(changed && w.stable());
}

int main(int argc, char** argv) {
  if (argc > 1) g_repo_root = argv[1];
  for (const Entry& e : registry()) {
    g_current = e.name;
    int before = g_failures;
    e.fn();
    printf("%s %s\n", g_failures == before ? "PASS" : "FAIL", e.name);
  }
  printf("\n%d checks, %d failures, %zu tests\n", g_checks, g_failures, registry().size());
  return g_failures == 0 ? 0 : 1;
}
