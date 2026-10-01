#pragma once
// Locked S10 pin map (ESP32 SP-WROOM-32 / ESP32-S dev board). Do not change casually; if a real
// conflict is found on the bench, document it in README.md and docs/DECISIONS.md first.
//
//   GPIO21  I2C SDA   -> INA219 (0x40), SHT41 (0x44), MPU6050 (0x68) share this bus
//   GPIO22  I2C SCL
//   GPIO26  Fan B MOSFET gate (active HIGH)       backup cooling equipment
//   GPIO27  vibration-motor MOSFET gate (active HIGH)   injected mechanical fault
//   GPIO32  rocker switch   (to GND, internal pull-up; closed = Fan B requested)
//   GPIO33  push button     (to GND, internal pull-up; press = toggle fault motor)
//
// None of these are strapping pins (0/2/5/12/15), flash pins (6-11) or input-only pins (34-39),
// so the board boots normally with the MOSFET modules attached. Fan A is wired through the INA219
// shunt and is powered continuously (no GPIO).
#include <stdint.h>

constexpr int PIN_I2C_SDA = 21;
constexpr int PIN_I2C_SCL = 22;
constexpr int PIN_FAN_B_MOSFET = 26;
constexpr int PIN_FAULT_MOTOR_MOSFET = 27;
constexpr int PIN_ROCKER = 32;
constexpr int PIN_BUTTON = 33;

constexpr uint8_t I2C_ADDR_INA219 = 0x40;
constexpr uint8_t I2C_ADDR_SHT41 = 0x44;
constexpr uint8_t I2C_ADDR_MPU6050 = 0x68;

/** MOSFET modules switch the load when the gate input is HIGH. Flip here if your module inverts. */
constexpr int OUTPUT_ACTIVE_LEVEL = 1;
