import { describe, expect, it } from "vitest";
import { assessTrust, parseTrustPolicy } from "./index";

const policy = parseTrustPolicy({ minConfidence: 0.5, requireHealthyDevice: true });
const good = {
  confidence: 1,
  stale: false,
  outOfRange: false,
  deviceHealthy: true,
  authVerified: true,
};

describe("assessTrust", () => {
  it("trusts fresh, in-range, authenticated data from a healthy device", () => {
    expect(assessTrust(good, policy)).toEqual({ trusted: true, reasons: [] });
  });

  it.each([
    [{ authVerified: false }, "NOT_AUTHENTICATED"],
    [{ stale: true }, "STALE"],
    [{ outOfRange: true }, "OUT_OF_RANGE"],
    [{ deviceHealthy: false }, "DEVICE_NOT_HEALTHY"],
    [{ confidence: 0.49 }, "LOW_CONFIDENCE"],
  ] as const)("refuses %j (%s)", (change, reason) => {
    const r = assessTrust({ ...good, ...change }, policy);
    expect(r.trusted).toBe(false);
    expect(r.reasons).toContain(reason);
  });

  it("confidence exactly at the minimum is trusted", () => {
    expect(assessTrust({ ...good, confidence: 0.5 }, policy).trusted).toBe(true);
  });

  it("tolerates an unhealthy device only if the policy allows, never unauthenticated or stale data", () => {
    const lenient = { minConfidence: 0.5, requireHealthyDevice: false };
    expect(assessTrust({ ...good, deviceHealthy: false }, lenient).trusted).toBe(true);
    expect(assessTrust({ ...good, authVerified: false }, lenient).trusted).toBe(false);
    expect(assessTrust({ ...good, stale: true }, lenient).trusted).toBe(false);
  });

  it("NaN confidence is never trusted", () => {
    expect(assessTrust({ ...good, confidence: Number.NaN }, policy).trusted).toBe(false);
  });

  it("rejects malformed policies", () => {
    expect(() => parseTrustPolicy({})).toThrow();
    expect(() => parseTrustPolicy({ minConfidence: 3, requireHealthyDevice: true })).toThrow();
  });
});
