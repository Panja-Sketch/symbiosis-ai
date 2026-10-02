import { createHash } from "node:crypto";
import { InMemoryDeviceKeyStore, createEdgeDeviceRecord } from "@symbiosis/device-registry";
import type { DeviceRecord } from "@symbiosis/device-registry";
import type { FacilityModel } from "@symbiosis/simulation";

/**
 * Registry records for the simulated facility's vendor devices and its weather feed (S10, D-088).
 * One definition serves the local runtime, the tests and the operator seed script, so what is
 * seeded in the cloud is exactly what is tested.
 */
export function simulationDeviceRecords(facility: FacilityModel): readonly DeviceRecord[] {
  const vendors = facility.devices.map((d) =>
    createEdgeDeviceRecord({
      deviceId: d.deviceId,
      keyId: d.keyId,
      organizationId: facility.organizationId,
      facilityId: facility.facilityId,
      assetId: d.assetId,
      ...(d.assetMapping !== undefined && { assetMapping: d.assetMapping }),
      expectedSignals: [...d.expectedSignals],
      capabilities: ["telemetry", "heartbeat"],
      sourceProfile: { profileId: d.profileId },
      displayName: d.displayName,
    }),
  );
  const outdoor = facility.assets.find((a) => a.kind === "WEATHER");
  if (outdoor === undefined) throw new Error("the simulation facility has no weather asset");
  // The weather feed is pulled by the platform, not sent by a device: its key id names no secret, so
  // nothing can ever sign a request for it.
  const weather = createEdgeDeviceRecord({
    deviceId: facility.weatherDeviceId,
    keyId: "KEY-NONE-INTERNAL",
    organizationId: facility.organizationId,
    facilityId: facility.facilityId,
    assetId: outdoor.assetId,
    expectedSignals: ["outdoor_temperature"],
    capabilities: ["pull"],
    displayName: "Weather feed",
  });
  return [...vendors, weather];
}

/**
 * LOCAL AND TEST KEYS ONLY. They are derived from the device id, are public in effect and grant
 * access to nothing real: the cloud uses random keys held in Secret Manager.
 */
export function syntheticSimulationKeys(facility: FacilityModel): InMemoryDeviceKeyStore {
  return new InMemoryDeviceKeyStore(
    facility.devices.map((d) => ({
      deviceId: d.deviceId,
      keyId: d.keyId,
      key: new Uint8Array(
        createHash("sha256").update(`synthetic-local-key|${d.deviceId}`).digest(),
      ),
    })),
  );
}
