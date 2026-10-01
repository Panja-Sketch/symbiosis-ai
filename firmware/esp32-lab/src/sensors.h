#pragma once
// Register-level drivers for the three I2C sensors (no third-party libraries). Pure conversions
// live in lib/symcore (host-tested); this file only talks to the bus.
#include <stddef.h>
#include <stdint.h>

namespace sensors {

void i2c_begin();
/** Prints every responding address and flags the three expected ones. Returns how many of the
 *  expected devices (0x40, 0x44, 0x68) answered. */
int i2c_scan_report();

bool sht41_init();
bool sht41_read(float* temperature_c, float* relative_humidity_pct);

bool mpu6050_init();
/** Blocks for about VIBRATION_WINDOW_SAMPLES ms. `tick` (optional) runs every sample period so the
 *  caller can keep polling inputs. Fails if too many bus reads fail. */
bool mpu6050_vibration(float* rms_ms2, void (*tick)());

bool ina219_init();
bool ina219_read(float* current_ma, float* bus_voltage_v);

}  // namespace sensors
