// Host command-line front end over the firmware core, used by the TypeScript compatibility tests
// to prove the C++ signing/serialization is accepted by the real server code.
//
//   sym_cli sha256 <hexdata>
//   sym_cli hmac <keyhex> <hexdata>
//   sym_cli sign <keyhex> <method> <path> <ts> <nonce> <seq> <bodyfile>
//   sym_cli telemetry <device_id> <fw> <epoch> <temp|-> <rh|-> <vib|-> <cur_ma|-> <fanb 0|1|->
//   sym_cli heartbeat <device_id> <fw> <epoch> <HEALTHY|DEGRADED|FAULT>
//   sym_cli selftest
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "sym_kat.h"
#include "sym_payload.h"
#include "sym_sha256.h"
#include "sym_signing.h"

using namespace sym;

static std::vector<uint8_t> unhex(const char* h) {
  size_t n = strlen(h) / 2;
  std::vector<uint8_t> out(n);
  if (!from_hex(h, n, out.data())) exit(2);
  return out;
}

static std::vector<uint8_t> slurp(const char* path) {
  FILE* f = fopen(path, "rb");
  if (f == nullptr) exit(2);
  std::vector<uint8_t> out;
  uint8_t buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.insert(out.end(), buf, buf + n);
  fclose(f);
  return out;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  std::string cmd = argv[1];
  if (cmd == "sha256" && argc == 3) {
    std::vector<uint8_t> d = unhex(argv[2]);
    uint8_t out[32];
    char h[65];
    sha256(d.data(), d.size(), out);
    to_hex(out, 32, h);
    puts(h);
    return 0;
  }
  if (cmd == "hmac" && argc == 4) {
    std::vector<uint8_t> k = unhex(argv[2]);
    std::vector<uint8_t> d = unhex(argv[3]);
    uint8_t out[32];
    char h[65];
    hmac_sha256(k.data(), k.size(), d.data(), d.size(), out);
    to_hex(out, 32, h);
    puts(h);
    return 0;
  }
  if (cmd == "sign" && argc == 9) {
    std::vector<uint8_t> key = unhex(argv[2]);
    if (key.size() != 32) return 2;
    std::vector<uint8_t> body = slurp(argv[8]);
    char hash[65], sig[65];
    if (!sign_request(key.data(), argv[3], argv[4], strtoull(argv[5], nullptr, 10), argv[6],
                      strtoull(argv[7], nullptr, 10), body.data(), body.size(), hash, sig)) {
      return 3;
    }
    printf("{\"bodySha256\":\"%s\",\"signature\":\"%s\"}\n", hash, sig);
    return 0;
  }
  if (cmd == "telemetry" && argc == 10) {
    Sample s;
    memset(&s, 0, sizeof(s));
    s.epoch_s = strtoull(argv[4], nullptr, 10);
    if (strcmp(argv[5], "-") != 0) { s.has_temperature = true; s.temperature_c = float(atof(argv[5])); }
    if (strcmp(argv[6], "-") != 0) { s.has_humidity = true; s.relative_humidity_pct = float(atof(argv[6])); }
    if (strcmp(argv[7], "-") != 0) { s.has_vibration = true; s.vibration_rms_ms2 = float(atof(argv[7])); }
    if (strcmp(argv[8], "-") != 0) { s.has_current = true; s.current_ma = float(atof(argv[8])); }
    if (strcmp(argv[9], "-") != 0) { s.has_fan_b = true; s.fan_b_running = argv[9][0] == '1'; }
    char body[1024];
    size_t n = serialize_telemetry(body, sizeof(body), argv[2], argv[3], &s, 1);
    if (n == 0) return 3;
    fwrite(body, 1, n, stdout);  // exact bytes, no trailing newline
    return 0;
  }
  if (cmd == "heartbeat" && argc == 6) {
    Health h = strcmp(argv[5], "HEALTHY") == 0 ? Health::kHealthy
               : strcmp(argv[5], "DEGRADED") == 0 ? Health::kDegraded : Health::kFault;
    char body[512];
    size_t n = serialize_heartbeat(body, sizeof(body), argv[2], argv[3],
                                   strtoull(argv[4], nullptr, 10), h);
    if (n == 0) return 3;
    fwrite(body, 1, n, stdout);
    return 0;
  }
  if (cmd == "selftest") {
    char detail[32];
    bool ok = signing_self_test(detail, sizeof(detail));
    printf("%s %s\n", ok ? "PASS" : "FAIL", detail);
    return ok ? 0 : 1;
  }
  return 2;
}
