#pragma once
// Wi-Fi and wall-clock time. Time comes ONLY from SNTP: nothing here manufactures a timestamp.
#include <stdint.h>

namespace net {

void begin();                      // starts Wi-Fi (non-blocking) and SNTP
void service(uint32_t now_ms);     // reconnect with a bounded retry interval
bool wifi_up();

/** True only after SNTP has set the clock to a plausible value. */
bool time_synced();
/** Unix seconds; 0 unless time_synced(). */
uint64_t epoch_seconds();
/** Forces a fresh SNTP sync (after the server reported clock skew) and clears time_synced(). */
void request_resync();

}  // namespace net
