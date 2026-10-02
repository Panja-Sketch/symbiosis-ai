import { EVENT_SCHEMA_VERSION } from "@symbiosis/contracts";
import type { EventOfType, PlatformEvent, PlatformEventType } from "@symbiosis/contracts";
import type { EventBus, EventHandler, Unsubscribe } from "@symbiosis/event-bus";
import type { Logger } from "../logger";

/** Transport-neutral request/response, structurally identical to `@symbiosis/api`'s types. */
export type PushRequest = {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Uint8Array;
};
export type PushResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

/** The one thing the bus needs from a topic; the real one wraps `@google-cloud/pubsub`. */
export interface TopicPublisher {
  /**
   * Resolves with the message id only once Pub/Sub has durably accepted the message. Messages that
   * share an `orderingKey` are delivered to the subscriber in the order they were published.
   */
  publish(data: Buffer, attributes: Record<string, string>, orderingKey?: string): Promise<string>;
}

/**
 * Events of one facility are delivered in the order they were published (S10, D-098). The domain
 * assumes it (a gateway's load reading is stored before the vibration reading of the same instant;
 * the in-memory bus is FIFO), and unordered delivery broke it in the cloud. The key is the tenant
 * and facility, so unrelated tenants never wait for each other.
 */
export const orderingKeyFor = (event: Pick<PlatformEvent, "organization_id" | "facility_id">) =>
  `${event.organization_id}:${event.facility_id}`;

/**
 * Pub/Sub implementation of the `EventBus` port.
 *
 * - `publish` sends the existing event envelope, unchanged, as the message body (plus attributes
 *   for filtering/diagnostics). It resolves only after Pub/Sub accepted the message and REJECTS on
 *   failure, so a caller can never believe an event was emitted when it was not. It does not run
 *   handlers: delivery happens through the worker's subscription.
 * - `subscribe` only registers a handler. Handlers run when the worker receives a message and calls
 *   `dispatch`. Pub/Sub delivers at least once, so every handler must be idempotent (they are: S2-S8).
 */
export class PubSubBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler<PlatformEvent>[]>();

  constructor(private readonly topic: TopicPublisher) {}

  async publish(event: PlatformEvent): Promise<void> {
    await this.topic.publish(
      Buffer.from(JSON.stringify(event), "utf8"),
      {
        event_type: event.event_type,
        event_id: event.event_id,
        organization_id: event.organization_id,
        correlation_id: event.correlation_id,
        schema_version: event.schema_version,
      },
      orderingKeyFor(event),
    );
  }

  subscribe<T extends PlatformEventType>(
    type: T,
    handler: EventHandler<EventOfType<T>>,
  ): Unsubscribe {
    const wrapped = handler as unknown as EventHandler<PlatformEvent>;
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), wrapped]);
    return () => {
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter((h) => h !== wrapped),
      );
    };
  }

  handlerCount(type: string): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  /**
   * Runs every handler for the event. All handlers are attempted; if any failed, throws so the
   * message is NOT acknowledged and Pub/Sub redelivers it (handlers that already succeeded run
   * again, which their idempotency makes safe).
   */
  async dispatch(event: PlatformEvent): Promise<{ readonly handled: number }> {
    const list = [...(this.handlers.get(event.event_type) ?? [])];
    const failures: unknown[] = [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} handler(s) failed for ${event.event_type}`,
      );
    }
    return { handled: list.length };
  }
}

export type DecodedPush =
  | { readonly ok: true; readonly event: PlatformEvent; readonly messageId: string }
  | { readonly ok: false; readonly reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Validates the Pub/Sub push wrapper and the Symbiosis envelope inside it. Never throws. */
export function decodePushBody(raw: Uint8Array): DecodedPush {
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return { ok: false, reason: "push body is not JSON" };
  }
  if (!isObject(wrapper) || !isObject(wrapper.message)) {
    return { ok: false, reason: "push body has no message" };
  }
  const { data, messageId } = wrapper.message;
  if (typeof data !== "string") return { ok: false, reason: "message has no data" };
  let event: unknown;
  try {
    event = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "message data is not JSON" };
  }
  if (!isObject(event)) return { ok: false, reason: "event is not an object" };
  const requiredStrings = [
    "event_id",
    "event_type",
    "correlation_id",
    "organization_id",
    "facility_id",
    "occurred_at",
  ] as const;
  for (const f of requiredStrings) {
    if (!nonEmpty(event[f])) return { ok: false, reason: `envelope field ${f} is missing` };
  }
  if (event.schema_version !== EVENT_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported envelope schema_version" };
  }
  if (event.producer !== "api" && event.producer !== "worker") {
    return { ok: false, reason: "envelope producer is invalid" };
  }
  if (!(event.causation_id === null || nonEmpty(event.causation_id))) {
    return { ok: false, reason: "envelope causation_id is invalid" };
  }
  if (!isObject(event.payload)) return { ok: false, reason: "envelope payload is missing" };
  return {
    ok: true,
    event: event as unknown as PlatformEvent,
    messageId: typeof messageId === "string" ? messageId : "",
  };
}

export type PushAuthVerifier = (authorizationHeader: string | undefined) => Promise<boolean>;

export type EventInbox = {
  isProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
};

export type PushHandlerDeps = {
  readonly bus: PubSubBus;
  readonly inbox: EventInbox;
  readonly verifyCaller: PushAuthVerifier;
  readonly logger: Logger;
};

/**
 * HTTP handler for the worker's push subscription. Response codes ARE the delivery protocol:
 *   204 -> acknowledged (also for an event already completed, so duplicates are dropped);
 *   401 -> caller is not the push identity (nothing processed);
 *   400/500 -> not acknowledged: Pub/Sub retries with backoff and, after the subscription's
 *              maximum delivery attempts, moves the message to the dead-letter topic.
 * A malformed message is deliberately NOT acknowledged: it ends in the DLQ where an operator sees it.
 */
export function createPushHandler(
  deps: PushHandlerDeps,
): (request: PushRequest) => Promise<PushResponse> {
  return async (request) => {
    if (request.method.toUpperCase() !== "POST") {
      return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED" } } };
    }
    let authorized = false;
    try {
      authorized = await deps.verifyCaller(request.headers.authorization);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      deps.logger.log("WARNING", "push delivery rejected: caller not authorized");
      return { status: 401, body: { error: { code: "UNAUTHENTICATED" } } };
    }
    const decoded = decodePushBody(request.rawBody);
    if (!decoded.ok) {
      deps.logger.log("ERROR", "push delivery malformed", { reason: decoded.reason });
      return {
        status: 400,
        body: { error: { code: "MALFORMED_MESSAGE", message: decoded.reason } },
      };
    }
    const { event } = decoded;
    const log = deps.logger.child({
      component: "worker",
      eventId: event.event_id,
      eventType: event.event_type,
      correlationId: event.correlation_id,
      organizationId: event.organization_id,
    });
    try {
      if (await deps.inbox.isProcessed(event.event_id)) {
        log.log("INFO", "duplicate delivery dropped (already processed)");
        return { status: 204, body: "" };
      }
      const { handled } = await deps.bus.dispatch(event);
      await deps.inbox.markProcessed(event.event_id);
      log.log("INFO", "event processed", { handlers: handled });
      return { status: 204, body: "" };
    } catch (e) {
      log.log("ERROR", "event processing failed; will be redelivered", { error: e });
      return { status: 500, body: { error: { code: "PROCESSING_FAILED" } } };
    }
  };
}
