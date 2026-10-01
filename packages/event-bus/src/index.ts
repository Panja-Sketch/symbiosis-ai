import { EVENT_SCHEMA_VERSION } from "@symbiosis/contracts";
import type {
  EventEnvelope,
  EventOfType,
  EventProducer,
  PlatformEvent,
  PlatformEventType,
} from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/event-bus" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export type EventHandler<E> = (event: E) => void | Promise<void>;
export type Unsubscribe = () => void;

/**
 * Minimal typed event bus. InMemoryBus satisfies it locally; a later PubSubBus must satisfy
 * the same interface without changing domain code. Handlers must be idempotent: real
 * brokers deliver at least once.
 */
export interface EventBus {
  publish(event: PlatformEvent): Promise<void>;
  subscribe<T extends PlatformEventType>(
    type: T,
    handler: EventHandler<EventOfType<T>>,
  ): Unsubscribe;
}

export type DeadLetter = { readonly event: PlatformEvent; readonly error: unknown };

/**
 * In-process bus. Events are delivered in publish order; an event published from inside a
 * handler is queued behind the current one, and the outermost `publish` resolves only
 * once the whole cascade has been processed (so tests are deterministic). A throwing
 * handler does not stop delivery: the failure is recorded as a dead letter.
 */
export class InMemoryBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler<PlatformEvent>[]>();
  private readonly log: PlatformEvent[] = [];
  private readonly failures: DeadLetter[] = [];
  private readonly queue: PlatformEvent[] = [];
  private draining = false;

  async publish(event: PlatformEvent): Promise<void> {
    this.log.push(event);
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        for (const handler of [...(this.handlers.get(next.event_type) ?? [])]) {
          try {
            await handler(next);
          } catch (error) {
            this.failures.push({ event: next, error });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  subscribe<T extends PlatformEventType>(
    type: T,
    handler: EventHandler<EventOfType<T>>,
  ): Unsubscribe {
    const list = this.handlers.get(type) ?? [];
    const wrapped = handler as unknown as EventHandler<PlatformEvent>;
    list.push(wrapped);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        current.filter((h) => h !== wrapped),
      );
    };
  }

  /** Every event ever published, in order (local/testing aid; not part of EventBus). */
  history(): readonly PlatformEvent[] {
    return [...this.log];
  }

  deadLetters(): readonly DeadLetter[] {
    return [...this.failures];
  }
}

/** Produces identifiers; injectable so tests are deterministic. */
export interface IdGenerator {
  next(prefix: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;

  next(prefix: string): string {
    this.n += 1;
    return `${prefix}-${String(this.n).padStart(6, "0")}`;
  }
}

export function createEnvelope<TType extends string, TPayload>(
  ids: IdGenerator,
  fields: {
    readonly type: TType;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly organizationId: string;
    readonly facilityId: string;
    readonly occurredAt: string;
    readonly producer: EventProducer;
    readonly payload: TPayload;
  },
): EventEnvelope<TType, TPayload> {
  return {
    event_id: ids.next("EVT"),
    event_type: fields.type,
    schema_version: EVENT_SCHEMA_VERSION,
    correlation_id: fields.correlationId,
    causation_id: fields.causationId,
    organization_id: fields.organizationId,
    facility_id: fields.facilityId,
    occurred_at: fields.occurredAt,
    producer: fields.producer,
    payload: fields.payload,
  };
}
