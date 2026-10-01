#pragma once
// The telemetry uplink: bounded queue -> gate -> sign -> send -> classify -> retry / latch.
// Policy lives in lib/symcore (host-tested); this file wires it to the ESP32 services.
#include <stddef.h>
#include <stdint.h>

#include "sym_health.h"
#include "sym_payload.h"

namespace uplink {

/** Starts the uplink task. `kat_passed` is the result of the firmware known-answer signing
 *  self-test. Returns false if sending is not possible (see serial log). */
bool begin(bool kat_passed);
/** Thread-safe: called from the sampling loop. */
void enqueue(const sym::Sample& sample);
/** Latest sensor-derived health, sent in heartbeats. */
void set_health(sym::Health health);
bool latched();
void print_status();

}  // namespace uplink
