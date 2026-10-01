#pragma once
// Serial diagnostics. Rule: NEVER pass the device key, the signature inputs derived from it, the
// Wi-Fi password or a request body that contains secrets to these macros. A repository test
// (tests/unit/firmware-hygiene.test.ts) fails if a log call mentions key material.
#include <Arduino.h>

#define LOGF(tag, fmt, ...) Serial.printf("[%s] " fmt "\n", tag, ##__VA_ARGS__)
