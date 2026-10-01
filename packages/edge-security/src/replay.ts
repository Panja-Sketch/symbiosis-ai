export type ReplayCheck = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly seq: number;
  readonly timestampSeconds: number;
  readonly nowSeconds: number;
};

export type ReplayDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "NONCE_REPLAY" | "SEQUENCE_REUSE" | "SEQUENCE_ROLLBACK";
    };

/**
 * Replay-protection state. `checkAndRecord` must be atomic: it either accepts and records
 * the nonce/sequence, or rejects without recording anything. The in-memory version below
 * is local-only; a shared store (S9) can replace it without touching authentication.
 *
 * Enforced per (device, key): nonces unique within the retention window, and `seq`
 * strictly greater than the highest accepted so far (gaps allowed, e.g. after an outage
 * where the firmware dropped nothing but the server missed packets). Firmware must keep
 * its sequence monotonic across reboots (persist it, or seed from trusted time).
 * This guards HTTP requests; observation dedupe (device+signal+observed_at) is separate.
 */
export interface ReplayGuard {
  checkAndRecord(check: ReplayCheck): Promise<ReplayDecision>;
}

type DeviceState = { lastSeq: number | undefined; nonces: Map<string, number> };

export class InMemoryReplayGuard implements ReplayGuard {
  private readonly state = new Map<string, DeviceState>();

  /** `retentionSeconds` must be at least the auth freshness window (max age + future skew). */
  constructor(private readonly retentionSeconds: number = 600) {}

  async checkAndRecord(check: ReplayCheck): Promise<ReplayDecision> {
    const key = `${check.deviceId}|${check.keyId}`;
    const s = this.state.get(key) ?? { lastSeq: undefined, nonces: new Map<string, number>() };
    for (const [nonce, ts] of s.nonces) {
      if (ts < check.nowSeconds - this.retentionSeconds) s.nonces.delete(nonce);
    }
    if (s.nonces.has(check.nonce)) return { ok: false, reason: "NONCE_REPLAY" };
    if (s.lastSeq !== undefined) {
      if (check.seq === s.lastSeq) return { ok: false, reason: "SEQUENCE_REUSE" };
      if (check.seq < s.lastSeq) return { ok: false, reason: "SEQUENCE_ROLLBACK" };
    }
    s.nonces.set(check.nonce, check.timestampSeconds);
    s.lastSeq = check.seq;
    this.state.set(key, s);
    return { ok: true };
  }
}
