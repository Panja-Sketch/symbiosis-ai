import { FieldPath } from "@google-cloud/firestore";
import type { DocumentData } from "@google-cloud/firestore";
import type { AuditEntry } from "@symbiosis/contracts";
import type { AuditLog, NewAuditEntry } from "@symbiosis/audit";
import type { DeviceRecord, DeviceRegistry, DeviceSeen } from "@symbiosis/device-registry";
import type { ReplayCheck, ReplayDecision, ReplayGuard } from "@symbiosis/edge-security";
import { canAccessFacility } from "@symbiosis/tenancy";
import type {
  ActorContext,
  ActorDirectory,
  OrganizationDirectory,
  OrganizationRecord,
  Role,
} from "@symbiosis/tenancy";
import {
  COLLECTIONS as C,
  createCtx,
  decode,
  encode,
  isAlreadyExists,
  storedFields,
  tenantDocId,
} from "./common";
import type { Ctx, FirestoreAdapterOptions } from "./common";

/**
 * Append-only audit log. The sequence number is a per-organization counter advanced in the same
 * transaction that creates the entry, so numbers are gaps-free and unique per organization and a
 * retried transaction can never produce a duplicate. There is no update or delete. (A hot
 * organization is limited by Firestore's per-document write rate on the counter; acceptable for
 * the prototype and recorded in docs/GCP_RUNTIME.md.)
 */
export class FirestoreAuditLog implements AuditLog {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async append(entry: NewAuditEntry): Promise<AuditEntry> {
    const counterRef = this.ctx.col(C.auditCounters).doc(entry.organizationId);
    return this.ctx.db.runTransaction(async (tx) => {
      const counter = await tx.get(counterRef);
      const sequence = ((counter.get("last") as number | undefined) ?? 0) + 1;
      const stored: AuditEntry = {
        ...entry,
        auditId: `AUD-${String(sequence).padStart(6, "0")}`,
        sequence,
      };
      const entryRef = this.ctx
        .col(C.auditEntries)
        .doc(tenantDocId(entry.organizationId, String(sequence).padStart(12, "0")));
      tx.create(entryRef, {
        organizationId: entry.organizationId,
        ...(entry.caseId !== undefined && { caseId: entry.caseId }),
        sequence,
        json: encode(stored),
        ...storedFields(this.ctx),
      });
      tx.set(counterRef, { last: sequence, organizationId: entry.organizationId });
      return Object.freeze(stored);
    });
  }

  async listByCase(organizationId: string, caseId: string): Promise<readonly AuditEntry[]> {
    const snap = await this.ctx
      .col(C.auditEntries)
      .where("organizationId", "==", organizationId)
      .where("caseId", "==", caseId)
      .get();
    return snap.docs
      .map((d) => decode<AuditEntry>(d.data()) as AuditEntry)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async list(organizationId: string): Promise<readonly AuditEntry[]> {
    const snap = await this.ctx
      .col(C.auditEntries)
      .where("organizationId", "==", organizationId)
      .get();
    return snap.docs
      .map((d) => decode<AuditEntry>(d.data()) as AuditEntry)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Incremental read by document-id range (`<org>~<12-digit sequence>`), which needs no composite
   * index and reads only the new tail.
   */
  async listAfter(
    organizationId: string,
    afterSequence: number,
    limit = 1000,
  ): Promise<readonly AuditEntry[]> {
    const from = tenantDocId(organizationId, String(afterSequence + 1).padStart(12, "0"));
    const to = tenantDocId(organizationId, "999999999999");
    const snap = await this.ctx
      .col(C.auditEntries)
      .where(FieldPath.documentId(), ">=", from)
      .where(FieldPath.documentId(), "<=", to)
      .orderBy(FieldPath.documentId())
      .limit(limit)
      .get();
    return snap.docs
      .map((d) => decode<AuditEntry>(d.data()) as AuditEntry)
      .filter((e) => e.organizationId === organizationId);
  }

  async lastSequence(organizationId: string): Promise<number> {
    const counter = await this.ctx.col(C.auditCounters).doc(organizationId).get();
    return (counter.get("last") as number | undefined) ?? 0;
  }
}

/** Trusted actor records: the ONLY source of organization, facility scope and roles. */
export class FirestoreActorDirectory implements ActorDirectory {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  private toContext(data: DocumentData | undefined): ActorContext | undefined {
    if (data === undefined || data.disabled === true) return undefined;
    return decode<ActorContext>(data);
  }

  async get(actorId: string): Promise<ActorContext | undefined> {
    if (actorId.includes("/")) return undefined;
    const snap = await this.ctx.col(C.actors).doc(actorId).get();
    return snap.exists ? this.toContext(snap.data()) : undefined;
  }

  async findByRole(organizationId: string, facilityId: string, role: Role) {
    const snap = await this.ctx
      .col(C.actors)
      .where("organizationId", "==", organizationId)
      .where("roles", "array-contains", role)
      .get();
    return snap.docs
      .map((d) => this.toContext(d.data()))
      .filter((a): a is ActorContext => a !== undefined && canAccessFacility(a, facilityId))
      .sort((a, b) => a.actorId.localeCompare(b.actorId))[0];
  }

  /** Operator/seed use only (never reachable from a request). */
  async put(actor: ActorContext, options: { readonly disabled?: boolean } = {}): Promise<void> {
    await this.ctx
      .col(C.actors)
      .doc(actor.actorId)
      .set({
        organizationId: actor.organizationId,
        roles: actor.roles,
        disabled: options.disabled === true,
        json: encode(actor),
        ...storedFields(this.ctx),
      });
  }
}

export class FirestoreOrganizationDirectory implements OrganizationDirectory {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async get(organizationId: string): Promise<OrganizationRecord | undefined> {
    if (organizationId.includes("/")) return undefined;
    const snap = await this.ctx.col(C.organizations).doc(organizationId).get();
    return snap.exists ? decode<OrganizationRecord>(snap.data()) : undefined;
  }

  async put(org: OrganizationRecord): Promise<void> {
    await this.ctx
      .col(C.organizations)
      .doc(org.organizationId)
      .set({
        type: org.type,
        json: encode(org),
        ...storedFields(this.ctx),
      });
  }
}

/** Firebase UID -> actor id. A UID without a link is unauthorized, however valid its token. */
export interface IdentityLinkStore {
  actorIdForUid(uid: string): Promise<string | undefined>;
}

export class FirestoreIdentityLinks implements IdentityLinkStore {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async actorIdForUid(uid: string): Promise<string | undefined> {
    if (uid === "" || uid.includes("/")) return undefined;
    const snap = await this.ctx.col(C.identityLinks).doc(uid).get();
    const actorId = snap.exists ? snap.get("actorId") : undefined;
    return typeof actorId === "string" ? actorId : undefined;
  }

  /** Operator/seed use only. */
  async link(uid: string, actorId: string): Promise<void> {
    await this.ctx
      .col(C.identityLinks)
      .doc(uid)
      .set({ actorId, ...storedFields(this.ctx) });
  }
}

export class FirestoreDeviceRegistry implements DeviceRegistry {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    if (deviceId === "" || deviceId.includes("/")) return undefined;
    const snap = await this.ctx.col(C.devices).doc(deviceId).get();
    return snap.exists ? decode<DeviceRecord>(snap.data()) : undefined;
  }

  async listForFacility(organizationId: string, facilityId: string) {
    const snap = await this.ctx
      .col(C.devices)
      .where("organizationId", "==", organizationId)
      .where("facilityId", "==", facilityId)
      .get();
    return snap.docs.map((d) => decode<DeviceRecord>(d.data()) as DeviceRecord);
  }

  /** Transaction merge so a concurrent heartbeat and registry edit cannot lose each other. */
  async recordSeen(deviceId: string, seen: DeviceSeen): Promise<void> {
    const ref = this.ctx.col(C.devices).doc(deviceId);
    await this.ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? decode<DeviceRecord>(snap.data()) : undefined;
      if (current === undefined) return;
      const next: DeviceRecord = {
        ...current,
        lastSeenAt: seen.seenAt,
        ...(seen.firmwareVersion !== undefined && { firmwareVersion: seen.firmwareVersion }),
        ...(seen.health !== undefined && { health: seen.health }),
      };
      tx.update(ref, { json: encode(next), ...storedFields(this.ctx) });
    });
  }

  /**
   * Operator provisioning only: atomic create that fails if the device id already exists, so a
   * registered device can never be overwritten by accident. Holds no key material.
   */
  async create(device: DeviceRecord): Promise<void> {
    await this.ctx
      .col(C.devices)
      .doc(device.deviceId)
      .create({
        organizationId: device.organizationId,
        facilityId: device.facilityId,
        json: encode(device),
        ...storedFields(this.ctx),
      });
  }

  /** Operator/seed use only. Holds no key material. */
  async put(device: DeviceRecord): Promise<void> {
    await this.ctx
      .col(C.devices)
      .doc(device.deviceId)
      .set({
        organizationId: device.organizationId,
        facilityId: device.facilityId,
        json: encode(device),
        ...storedFields(this.ctx),
      });
  }
}

type ReplayDoc = { lastSeq?: number; nonces: Record<string, number> };

/**
 * Shared replay state (several API instances can run at once). `checkAndRecord` is one Firestore
 * transaction, so two requests carrying the same nonce or sequence cannot both be accepted.
 */
export class FirestoreReplayGuard implements ReplayGuard {
  private readonly ctx: Ctx;
  constructor(
    options: FirestoreAdapterOptions,
    private readonly retentionSeconds: number = 600,
  ) {
    this.ctx = createCtx(options);
  }

  async checkAndRecord(check: ReplayCheck): Promise<ReplayDecision> {
    const ref = this.ctx.col(C.replayState).doc(tenantDocId(check.deviceId, check.keyId));
    return this.ctx.db.runTransaction(async (tx): Promise<ReplayDecision> => {
      const snap = await tx.get(ref);
      const state: ReplayDoc = snap.exists
        ? (JSON.parse(snap.get("json") as string) as ReplayDoc)
        : { nonces: {} };
      const nonces: Record<string, number> = {};
      for (const [nonce, ts] of Object.entries(state.nonces)) {
        if (ts >= check.nowSeconds - this.retentionSeconds) nonces[nonce] = ts;
      }
      if (check.nonce in nonces) return { ok: false, reason: "NONCE_REPLAY" };
      if (state.lastSeq !== undefined) {
        if (check.seq === state.lastSeq) return { ok: false, reason: "SEQUENCE_REUSE" };
        if (check.seq < state.lastSeq) return { ok: false, reason: "SEQUENCE_ROLLBACK" };
      }
      nonces[check.nonce] = check.timestampSeconds;
      const next: ReplayDoc = { lastSeq: check.seq, nonces };
      tx.set(ref, {
        deviceId: check.deviceId,
        json: JSON.stringify(next),
        ...storedFields(this.ctx),
      });
      return { ok: true };
    });
  }
}

/**
 * Event inbox for at-least-once delivery. An event is marked only AFTER every handler succeeded,
 * so a failed delivery is retried, and a redelivery of a finished event is dropped. Handlers stay
 * idempotent on their own: two concurrent deliveries of the same event can both run.
 */
export class FirestoreEventInbox {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async isProcessed(eventId: string): Promise<boolean> {
    if (eventId.includes("/")) return false;
    return (await this.ctx.col(C.processedEvents).doc(eventId).get()).exists;
  }

  async markProcessed(eventId: string): Promise<void> {
    try {
      await this.ctx.col(C.processedEvents).doc(eventId).create(storedFields(this.ctx));
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
  }
}
