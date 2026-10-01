#pragma once
// Local human-driven inputs and the two MOSFET outputs. This is the ONLY module that drives the
// actuator pins, and nothing received from the network can reach it: there is deliberately no
// cloud-to-equipment control path (architecture boundary: AI advises, humans act, sensors verify).
#include <stdint.h>

namespace io {

/** `control` false leaves the outputs LOW and ignores the rocker/button (sensor/cloud test modes). */
void begin(bool control);
/** Debounces the inputs and applies them: rocker -> Fan B, button press -> toggle fault motor. */
void poll(uint32_t now_ms);

bool rocker_closed();       // debounced switch state (human request for backup capacity)
bool fan_b_driven();        // level actually present on the Fan B gate pin (read back)
bool fault_motor_driven();  // level actually present on the fault-motor gate pin (read back)

// Direct output control, used only by the local bring-up shell (serial, on the bench).
void bench_set_fan_b(bool on);
void bench_set_fault_motor(bool on);
void bench_print_inputs(uint32_t now_ms);

}  // namespace io
