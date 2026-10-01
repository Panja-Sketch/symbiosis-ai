#include "sym_convert.h"

namespace sym {

uint8_t sensirion_crc8(uint8_t b0, uint8_t b1) {
  uint8_t crc = 0xFF;
  const uint8_t data[2] = {b0, b1};
  for (int i = 0; i < 2; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? uint8_t((crc << 1) ^ 0x31) : uint8_t(crc << 1);
  }
  return crc;
}

bool sht4x_decode(const uint8_t raw[6], float* temperature_c, float* relative_humidity_pct) {
  if (sensirion_crc8(raw[0], raw[1]) != raw[2]) return false;
  if (sensirion_crc8(raw[3], raw[4]) != raw[5]) return false;
  const float t_ticks = float((uint16_t(raw[0]) << 8) | raw[1]);
  const float rh_ticks = float((uint16_t(raw[3]) << 8) | raw[4]);
  *temperature_c = -45.0f + 175.0f * t_ticks / 65535.0f;
  float rh = -6.0f + 125.0f * rh_ticks / 65535.0f;
  if (rh < 0.0f) rh = 0.0f;
  if (rh > 100.0f) rh = 100.0f;
  *relative_humidity_pct = rh;
  return true;
}

float ina219_shunt_to_ma(int16_t shunt_reg, float shunt_ohms) {
  // volts = reg * 10 uV ; mA = volts / ohms * 1000
  return float(shunt_reg) * 0.01f / shunt_ohms;
}

float ina219_bus_to_v(uint16_t bus_reg) { return float(bus_reg >> 3) * 0.004f; }

int16_t be16(uint8_t hi, uint8_t lo) { return int16_t((uint16_t(hi) << 8) | lo); }

}  // namespace sym
