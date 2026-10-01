#include "net.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_sntp.h>
#include <sys/time.h>
#include <time.h>

#include "config.h"
#include "diag.h"
#include "sym_gate.h"

namespace net {

namespace {
volatile bool g_sntp_done = false;
uint32_t g_last_wifi_attempt = 0;
bool g_started = false;
bool g_was_up = false;

void on_time_synced(struct timeval*) { g_sntp_done = true; }
}  // namespace

void begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(SYM_WIFI_SSID, SYM_WIFI_PASSWORD);  // password is never printed
  g_last_wifi_attempt = millis();
  LOGF("wifi", "connecting to SSID \"%s\"", SYM_WIFI_SSID);
  sntp_set_time_sync_notification_cb(on_time_synced);
  configTime(0, 0, "time.google.com", "pool.ntp.org", "time.cloudflare.com");
  g_started = true;
}

void service(uint32_t now_ms) {
  if (!g_started) return;
  const bool up = WiFi.status() == WL_CONNECTED;
  if (up && !g_was_up) {
    LOGF("wifi", "connected, ip=%s rssi=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else if (!up && g_was_up) {
    LOGF("wifi", "connection lost");
  }
  g_was_up = up;
  if (!up && uint32_t(now_ms - g_last_wifi_attempt) >= WIFI_RETRY_MS) {
    g_last_wifi_attempt = now_ms;
    WiFi.disconnect();
    WiFi.begin(SYM_WIFI_SSID, SYM_WIFI_PASSWORD);
    LOGF("wifi", "retrying");
  }
}

bool wifi_up() { return WiFi.status() == WL_CONNECTED; }

bool time_synced() {
  if (!g_sntp_done) return false;
  return uint64_t(time(nullptr)) >= sym::kMinPlausibleEpoch;
}

uint64_t epoch_seconds() { return time_synced() ? uint64_t(time(nullptr)) : 0; }

void request_resync() {
  g_sntp_done = false;
  sntp_restart();
  LOGF("time", "SNTP resync requested");
}

}  // namespace net
