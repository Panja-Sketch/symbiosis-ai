import type { NotificationDelivery } from "@symbiosis/contracts";
import type { TenantDocumentStore } from "@symbiosis/repositories";

/**
 * Persisted delivery attempts (S10, D-090). `reserve` is an atomic create keyed by
 * `alertId#attempt`: of any number of concurrent or redelivered executions of the same attempt,
 * exactly one wins and may send. Sending is therefore at most once per attempt, whatever the
 * broker redelivers.
 */
export interface DeliveryStore {
  /** True only for the single caller that created the record. */
  reserve(delivery: NotificationDelivery): Promise<boolean>;
  get(organizationId: string, deliveryId: string): Promise<NotificationDelivery | undefined>;
  /** Replaces a record; used once, to complete a reserved attempt. */
  complete(delivery: NotificationDelivery): Promise<void>;
  listByAlert(organizationId: string, alertId: string): Promise<readonly NotificationDelivery[]>;
  listByCase(organizationId: string, caseId: string): Promise<readonly NotificationDelivery[]>;
  /** Attempts reserved long ago and never completed (a crash between reserve and result). */
  listPendingBefore(
    organizationId: string,
    beforeIso: string,
  ): Promise<readonly NotificationDelivery[]>;
}

export const deliveryIdFor = (alertId: string, attempt: number) => `${alertId}#${attempt}`;

export class StoreDeliveryStore implements DeliveryStore {
  constructor(private readonly store: TenantDocumentStore) {}

  private index(d: NotificationDelivery) {
    return {
      alertId: d.alertId,
      caseId: d.caseId,
      status: d.status,
      requestedAtMs: Date.parse(d.requestedAt),
    };
  }

  reserve(d: NotificationDelivery) {
    return this.store.create(
      "notificationDeliveries",
      d.organizationId,
      d.deliveryId,
      d,
      this.index(d),
    );
  }

  get(organizationId: string, deliveryId: string) {
    return this.store.get<NotificationDelivery>(
      "notificationDeliveries",
      organizationId,
      deliveryId,
    );
  }

  async complete(d: NotificationDelivery) {
    await this.store.put(
      "notificationDeliveries",
      d.organizationId,
      d.deliveryId,
      d,
      this.index(d),
    );
  }

  listByAlert(organizationId: string, alertId: string) {
    return this.store.list<NotificationDelivery>("notificationDeliveries", organizationId, {
      where: { alertId },
    });
  }

  listByCase(organizationId: string, caseId: string) {
    return this.store.list<NotificationDelivery>("notificationDeliveries", organizationId, {
      where: { caseId },
    });
  }

  async listPendingBefore(organizationId: string, beforeIso: string) {
    const pending = await this.store.list<NotificationDelivery>(
      "notificationDeliveries",
      organizationId,
      { where: { status: "PENDING" } },
    );
    const before = Date.parse(beforeIso);
    return pending.filter((d) => Date.parse(d.requestedAt) < before);
  }
}
