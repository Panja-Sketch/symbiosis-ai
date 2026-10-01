import { describe, expect, it } from "vitest";
import { ManualClock, SystemClock, nowIso, nowSeconds } from "./index";

describe("clocks", () => {
  it("ManualClock is deterministic and controllable", () => {
    const c = new ManualClock(1_790_000_000_000);
    expect(nowSeconds(c)).toBe(1_790_000_000);
    expect(nowIso(c)).toBe(new Date(1_790_000_000_000).toISOString());
    c.advance(1500);
    expect(c.nowMs()).toBe(1_790_000_001_500);
    expect(nowSeconds(c)).toBe(1_790_000_001);
    c.set(0);
    expect(nowIso(c)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("SystemClock returns a plausible current time", () => {
    expect(Math.abs(new SystemClock().nowMs() - Date.now())).toBeLessThan(1000);
  });
});
