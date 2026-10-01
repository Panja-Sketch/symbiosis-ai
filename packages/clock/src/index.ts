export const PACKAGE_NAME = "@symbiosis/clock" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Time source abstraction (spec section 39: SystemClock | DemoClock). */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** Deterministic, manually advanced clock for tests and demos. */
export class ManualClock implements Clock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  nowMs(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export function nowIso(clock: Clock): string {
  return new Date(clock.nowMs()).toISOString();
}

export function nowSeconds(clock: Clock): number {
  return Math.floor(clock.nowMs() / 1000);
}
