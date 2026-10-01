import type { DomainEntity } from "./errors";
import type { IsoTimestamp } from "./primitives";

/**
 * Describes one applied state transition. Domain functions return it so a caller
 * (later: the audit package) can persist it; the domain itself performs no I/O.
 */
export type TransitionRecord<S extends string> = {
  readonly entity: DomainEntity;
  readonly entityId: string;
  readonly from: S;
  readonly to: S;
  readonly command: string;
  readonly at: IsoTimestamp;
  readonly actorId?: string;
};

export type Transitioned<T, S extends string> = {
  readonly value: T;
  readonly record: TransitionRecord<S>;
};
