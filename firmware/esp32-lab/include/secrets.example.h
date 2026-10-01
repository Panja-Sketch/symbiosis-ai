#pragma once
// TEMPLATE. Copy to `secrets.h` (git-ignored) and fill in, or let `pnpm provision:device`
// generate the device section for you. With this template the firmware still COMPILES, but it
// refuses to send telemetry (SYM_SECRETS_ARE_PLACEHOLDER).
//
// Never commit secrets.h. The device key is a 64-hex-character (32-byte) HMAC key that lives in
// Secret Manager as symbiosis-device-key-<DEVICE_ID>-<KEY_ID>.
#define SYM_SECRETS_ARE_PLACEHOLDER 1

#define SYM_WIFI_SSID "your-wifi-name"
#define SYM_WIFI_PASSWORD "your-wifi-password"

// Base URL of the edge API: scheme + host only, no trailing slash, no path.
#define SYM_API_BASE_URL "https://symbiosis-api-554089078085.us-central1.run.app"

#define SYM_DEVICE_ID "DEV-PHX-BENCH-001"
#define SYM_KEY_ID "KEY-PHX-BENCH-001"
#define SYM_DEVICE_KEY_HEX "0000000000000000000000000000000000000000000000000000000000000000"
