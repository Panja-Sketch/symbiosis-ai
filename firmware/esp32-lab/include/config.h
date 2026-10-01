#pragma once
// Build-time configuration shared by every firmware mode. Business thresholds do NOT live here:
// firmware only measures and reports; the server decides (risk, verification, lifecycle).
#include <stdint.h>

#define SYM_MODE_BRINGUP 1
#define SYM_MODE_SENSOR_TEST 2
#define SYM_MODE_SIGNING_TEST 3
#define SYM_MODE_CLOUD_TEST 4
#define SYM_MODE_DEMO 5

#ifndef SYM_MODE
#define SYM_MODE SYM_MODE_DEMO
#endif

#ifndef SYM_GIT_SHA
#define SYM_GIT_SHA "nogit"
#endif
#define SYM_FW_BASE_VERSION "0.1.0"
/** Sent as firmware_version: diagnostics / evidence provenance only, never risk logic. */
#define SYM_FW_VERSION SYM_FW_BASE_VERSION "+g" SYM_GIT_SHA

#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// ---- sampling (matches config/verification-policy expectedIntervalSeconds = 5) -----------------
constexpr uint32_t SAMPLE_INTERVAL_MS = 5000;
/** Accelerometer window: 512 reads paced at 1 kHz (~0.5 s), +/-4 g, sensor bandwidth 260 Hz. */
constexpr uint16_t VIBRATION_WINDOW_SAMPLES = 512;
constexpr uint32_t VIBRATION_SAMPLE_PERIOD_US = 1000;
constexpr uint8_t CURRENT_AVERAGE_READS = 8;
/** Shunt on common INA219 breakout boards is 0.1 ohm; change if yours differs. */
constexpr float INA219_SHUNT_OHMS = 0.1f;

// ---- uplink --------------------------------------------------------------------------------------
/** Unsent samples kept in RAM (about 10 minutes at 5 s). Oldest dropped first; never in flash. */
constexpr uint16_t QUEUE_CAPACITY = 120;
constexpr uint8_t MAX_SAMPLES_PER_REQUEST = 20;
constexpr uint32_t SEND_INTERVAL_MS = 15000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 30000;
constexpr uint32_t HTTP_CONNECT_TIMEOUT_MS = 8000;
constexpr uint32_t HTTP_TIMEOUT_MS = 10000;
constexpr uint32_t WIFI_RETRY_MS = 10000;
constexpr uint8_t MAX_CLOCK_SKEW_RETRIES = 5;

constexpr uint32_t INPUT_DEBOUNCE_MS = 40;
constexpr uint32_t STATUS_PRINT_MS = 30000;
