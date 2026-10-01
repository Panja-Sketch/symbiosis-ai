#pragma once
// Pure raw-register -> engineering-unit conversions for the three I2C sensors.
#include <stddef.h>
#include <stdint.h>

namespace sym {

/** Sensirion CRC-8 (poly 0x31, init 0xFF) over two bytes. */
uint8_t sensirion_crc8(uint8_t b0, uint8_t b1);

/** Decodes a 6-byte SHT4x reply (T msb,lsb,crc, RH msb,lsb,crc). False if a CRC fails. */
bool sht4x_decode(const uint8_t raw[6], float* temperature_c, float* relative_humidity_pct);

/** INA219 shunt-voltage register (LSB 10 uV, signed) -> current in mA for `shunt_ohms`. */
float ina219_shunt_to_ma(int16_t shunt_reg, float shunt_ohms);

/** INA219 bus-voltage register (bits 15:3, LSB 4 mV) -> volts. */
float ina219_bus_to_v(uint16_t bus_reg);

/** MPU6050 big-endian register pair -> signed 16-bit. */
int16_t be16(uint8_t hi, uint8_t lo);

}  // namespace sym
