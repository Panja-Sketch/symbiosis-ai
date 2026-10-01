#include "sensors.h"

#include <Arduino.h>
#include <Wire.h>

#include "config.h"
#include "diag.h"
#include "pins.h"
#include "sym_convert.h"
#include "sym_vibration.h"

namespace sensors {

namespace {

bool write_reg8(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool read_regs(uint8_t addr, uint8_t reg, uint8_t* out, size_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(int(addr), int(n)) != int(n)) return false;
  for (size_t i = 0; i < n; i++) out[i] = uint8_t(Wire.read());
  return true;
}

bool write_reg16(uint8_t addr, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(uint8_t(value >> 8));
  Wire.write(uint8_t(value & 0xff));
  return Wire.endTransmission() == 0;
}

bool read_reg16(uint8_t addr, uint8_t reg, uint16_t* out) {
  uint8_t b[2];
  if (!read_regs(addr, reg, b, 2)) return false;
  *out = (uint16_t(b[0]) << 8) | b[1];
  return true;
}

// ---- INA219 registers ----
constexpr uint8_t INA_REG_CONFIG = 0x00;
constexpr uint8_t INA_REG_SHUNT = 0x01;
constexpr uint8_t INA_REG_BUS = 0x02;
// 16 V bus range, gain /8 (+/-320 mV), 12-bit bus, 12-bit shunt averaged over 32 samples, continuous.
constexpr uint16_t INA_CONFIG = 0x19EF;

// ---- MPU6050 registers ----
constexpr uint8_t MPU_REG_SMPLRT_DIV = 0x19;
constexpr uint8_t MPU_REG_CONFIG = 0x1A;
constexpr uint8_t MPU_REG_ACCEL_CONFIG = 0x1C;
constexpr uint8_t MPU_REG_ACCEL_XOUT_H = 0x3B;
constexpr uint8_t MPU_REG_PWR_MGMT_1 = 0x6B;
constexpr uint8_t MPU_REG_WHO_AM_I = 0x75;

}  // namespace

void i2c_begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(400000);
  Wire.setTimeOut(50);
}

int i2c_scan_report() {
  int expected_found = 0;
  int total = 0;
  for (uint8_t addr = 0x08; addr < 0x78; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      const char* label = "";
      if (addr == I2C_ADDR_INA219) { label = " INA219 (Fan A current)"; expected_found++; }
      else if (addr == I2C_ADDR_SHT41) { label = " SHT41 (zone temp/humidity)"; expected_found++; }
      else if (addr == I2C_ADDR_MPU6050) { label = " MPU6050 (vibration)"; expected_found++; }
      LOGF("i2c", "0x%02X%s", addr, label);
      total++;
    }
  }
  LOGF("i2c", "%d device(s) found, %d of 3 expected (0x40, 0x44, 0x68)", total, expected_found);
  return expected_found;
}

// ---- SHT41 -------------------------------------------------------------------------------------
bool sht41_init() {
  Wire.beginTransmission(I2C_ADDR_SHT41);
  Wire.write(uint8_t(0x94));  // soft reset
  if (Wire.endTransmission() != 0) return false;
  delay(2);
  // Read serial number (0x89): proves the part answers and its CRCs are valid.
  Wire.beginTransmission(I2C_ADDR_SHT41);
  Wire.write(uint8_t(0x89));
  if (Wire.endTransmission() != 0) return false;
  delay(2);
  if (Wire.requestFrom(int(I2C_ADDR_SHT41), 6) != 6) return false;
  uint8_t sn[6];
  for (int i = 0; i < 6; i++) sn[i] = uint8_t(Wire.read());
  return sym::sensirion_crc8(sn[0], sn[1]) == sn[2] && sym::sensirion_crc8(sn[3], sn[4]) == sn[5];
}

bool sht41_read(float* temperature_c, float* relative_humidity_pct) {
  Wire.beginTransmission(I2C_ADDR_SHT41);
  Wire.write(uint8_t(0xFD));  // high-precision measurement
  if (Wire.endTransmission() != 0) return false;
  delay(10);  // max 8.3 ms
  if (Wire.requestFrom(int(I2C_ADDR_SHT41), 6) != 6) return false;
  uint8_t raw[6];
  for (int i = 0; i < 6; i++) raw[i] = uint8_t(Wire.read());
  return sym::sht4x_decode(raw, temperature_c, relative_humidity_pct);
}

// ---- MPU6050 -----------------------------------------------------------------------------------
bool mpu6050_init() {
  uint8_t who = 0;
  if (!read_regs(I2C_ADDR_MPU6050, MPU_REG_WHO_AM_I, &who, 1)) return false;
  LOGF("mpu6050", "WHO_AM_I=0x%02X", who);
  // 0x68 is a genuine MPU6050; some GY-521 clones report 0x70/0x71/0x72 (MPU6500 family).
  if (who != 0x68 && who != 0x70 && who != 0x71 && who != 0x72) return false;
  if (!write_reg8(I2C_ADDR_MPU6050, MPU_REG_PWR_MGMT_1, 0x01)) return false;  // wake, PLL clock
  delay(50);
  if (!write_reg8(I2C_ADDR_MPU6050, MPU_REG_CONFIG, 0x00)) return false;       // DLPF 260 Hz
  if (!write_reg8(I2C_ADDR_MPU6050, MPU_REG_SMPLRT_DIV, 7)) return false;      // 8 kHz/8 = 1 kHz
  if (!write_reg8(I2C_ADDR_MPU6050, MPU_REG_ACCEL_CONFIG, 0x08)) return false; // +/-4 g
  uint8_t cfg = 0;
  if (!read_regs(I2C_ADDR_MPU6050, MPU_REG_ACCEL_CONFIG, &cfg, 1)) return false;
  return cfg == 0x08;
}

bool mpu6050_vibration(float* rms_ms2, void (*tick)()) {
  sym::VibrationAccumulator acc;
  uint16_t failures = 0;
  uint32_t next = micros();
  for (uint16_t i = 0; i < VIBRATION_WINDOW_SAMPLES; i++) {
    next += VIBRATION_SAMPLE_PERIOD_US;
    uint8_t b[6];
    if (read_regs(I2C_ADDR_MPU6050, MPU_REG_ACCEL_XOUT_H, b, 6)) {
      acc.add(sym::be16(b[0], b[1]), sym::be16(b[2], b[3]), sym::be16(b[4], b[5]));
    } else {
      failures++;
    }
    if (tick != nullptr) tick();
    while (int32_t(micros() - next) < 0) {
    }
  }
  if (failures > VIBRATION_WINDOW_SAMPLES / 20) return false;  // more than 5% bus errors
  return acc.rms_ms2(sym::kMpuLsbPerG4g, rms_ms2);
}

// ---- INA219 ------------------------------------------------------------------------------------
bool ina219_init() {
  if (!write_reg16(I2C_ADDR_INA219, INA_REG_CONFIG, 0x8000)) return false;  // reset
  delay(2);
  if (!write_reg16(I2C_ADDR_INA219, INA_REG_CONFIG, INA_CONFIG)) return false;
  delay(5);
  uint16_t readback = 0;
  if (!read_reg16(I2C_ADDR_INA219, INA_REG_CONFIG, &readback)) return false;
  return readback == INA_CONFIG;
}

bool ina219_read(float* current_ma, float* bus_voltage_v) {
  float sum = 0;
  for (uint8_t i = 0; i < CURRENT_AVERAGE_READS; i++) {
    uint16_t shunt = 0;
    if (!read_reg16(I2C_ADDR_INA219, INA_REG_SHUNT, &shunt)) return false;
    sum += sym::ina219_shunt_to_ma(int16_t(shunt), INA219_SHUNT_OHMS);
    delay(2);
  }
  uint16_t bus = 0;
  if (!read_reg16(I2C_ADDR_INA219, INA_REG_BUS, &bus)) return false;
  *current_ma = sum / float(CURRENT_AVERAGE_READS);
  *bus_voltage_v = sym::ina219_bus_to_v(bus);
  return true;
}

}  // namespace sensors
