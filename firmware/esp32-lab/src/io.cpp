#include "io.h"

#include <Arduino.h>
#include <driver/gpio.h>

#include "config.h"
#include "diag.h"
#include "pins.h"
#include "sym_debounce.h"

namespace io {

namespace {
bool g_control = false;
sym::Debouncer g_rocker(INPUT_DEBOUNCE_MS);
sym::Debouncer g_button(INPUT_DEBOUNCE_MS);

void drive(int pin, bool on) {
  digitalWrite(pin, on ? OUTPUT_ACTIVE_LEVEL : !OUTPUT_ACTIVE_LEVEL);
}
bool driven(int pin) { return gpio_get_level(static_cast<gpio_num_t>(pin)) == OUTPUT_ACTIVE_LEVEL; }

void output_pin(int pin) {
  digitalWrite(pin, !OUTPUT_ACTIVE_LEVEL);  // inactive BEFORE it becomes an output
  pinMode(pin, OUTPUT);
  // Keep the input buffer enabled so the real pad level can be read back and reported.
  gpio_set_direction(static_cast<gpio_num_t>(pin), GPIO_MODE_INPUT_OUTPUT);
  digitalWrite(pin, !OUTPUT_ACTIVE_LEVEL);
}
}  // namespace

void begin(bool control) {
  g_control = control;
  output_pin(PIN_FAN_B_MOSFET);
  output_pin(PIN_FAULT_MOTOR_MOSFET);
  pinMode(PIN_ROCKER, INPUT_PULLUP);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  const uint32_t now = millis();
  // Closed to ground = LOW = "on". The fault motor always starts OFF.
  g_rocker.reset(digitalRead(PIN_ROCKER) == LOW, now);
  g_button.reset(digitalRead(PIN_BUTTON) == LOW, now);
  if (g_control) drive(PIN_FAN_B_MOSFET, g_rocker.stable());
}

void poll(uint32_t now_ms) {
  if (!g_control) return;
  if (g_rocker.update(digitalRead(PIN_ROCKER) == LOW, now_ms)) {
    drive(PIN_FAN_B_MOSFET, g_rocker.stable());
    LOGF("io", "rocker %s -> Fan B %s", g_rocker.stable() ? "closed" : "open",
         g_rocker.stable() ? "ON" : "OFF");
  }
  if (g_button.update(digitalRead(PIN_BUTTON) == LOW, now_ms) && g_button.stable()) {
    const bool now_on = !driven(PIN_FAULT_MOTOR_MOSFET);
    drive(PIN_FAULT_MOTOR_MOSFET, now_on);
    LOGF("io", "button pressed -> fault motor %s", now_on ? "ON (injected degradation)" : "OFF");
  }
}

bool rocker_closed() { return g_rocker.stable(); }
bool fan_b_driven() { return driven(PIN_FAN_B_MOSFET); }
bool fault_motor_driven() { return driven(PIN_FAULT_MOTOR_MOSFET); }

void bench_set_fan_b(bool on) {
  drive(PIN_FAN_B_MOSFET, on);
  delay(5);
  LOGF("bench", "Fan B commanded %s, pin reads back %s", on ? "ON" : "OFF",
       fan_b_driven() ? "ON" : "OFF");
}

void bench_set_fault_motor(bool on) {
  drive(PIN_FAULT_MOTOR_MOSFET, on);
  delay(5);
  LOGF("bench", "fault motor commanded %s, pin reads back %s", on ? "ON" : "OFF",
       fault_motor_driven() ? "ON" : "OFF");
}

void bench_print_inputs(uint32_t now_ms) {
  static int last_r = -1, last_b = -1;
  const int r = digitalRead(PIN_ROCKER), b = digitalRead(PIN_BUTTON);
  g_rocker.update(r == LOW, now_ms);
  g_button.update(b == LOW, now_ms);
  if (r != last_r || b != last_b) {
    LOGF("bench", "raw rocker=%d button=%d | debounced rocker=%s button=%s", r, b,
         g_rocker.stable() ? "closed" : "open", g_button.stable() ? "pressed" : "released");
    last_r = r;
    last_b = b;
  }
}

}  // namespace io
