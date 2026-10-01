#pragma once
// Firmware-side known-answer test against the S2 vector (firmware-contracts/sample-packets/
// signing-vector.json). The constants in sym_kat.cpp are the vector itself; a host test asserts they
// stay byte-identical to the JSON files. If this fails the firmware must NOT send telemetry.
#include <stddef.h>

namespace sym {

extern const char* const kKatKeyHex;
extern const char* const kKatMethod;
extern const char* const kKatPath;
extern const char* const kKatTimestamp;
extern const char* const kKatNonce;
extern const char* const kKatSeq;
extern const char* const kKatBody;
extern const char* const kKatBodySha256;
extern const char* const kKatSigningMaterial;
extern const char* const kKatSignature;

/** Runs the vector. On failure `detail` names the stage that mismatched (never a secret). */
bool signing_self_test(char* detail, size_t cap);

}  // namespace sym
