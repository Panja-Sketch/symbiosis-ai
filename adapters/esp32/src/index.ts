import { createEdgeV1Adapter } from "@symbiosis/normalization";

export const PACKAGE_NAME = "@symbiosis/adapter-esp32" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export * from "./bench-device";

export const ESP32_ADAPTER_NAME = "esp32-edge-v1" as const;

/**
 * Server-side source adapter for packets from the ESP32 prototype (spec section 28). It
 * only describes how an edge v1 HARDWARE packet maps to canonical observations. The
 * firmware itself lives in firmware/esp32-lab; `bench-device.ts` holds the registry template.
 */
export const esp32SourceAdapter = createEdgeV1Adapter({
  adapterName: ESP32_ADAPTER_NAME,
  sourceType: "HARDWARE",
});
