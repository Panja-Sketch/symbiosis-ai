import { createHash } from "node:crypto";
import type { CollectionReference, DocumentData, Firestore } from "@google-cloud/firestore";

/**
 * Shared Firestore plumbing for the production repositories (S9).
 *
 * Record shape. Every record is stored as ONE document:
 *   - `json`: the exact domain record, serialized with `JSON.stringify`. The domain types contain
 *     nested arrays and optional fields, which Firestore's native model rejects, and a string
 *     round-trips byte-for-byte, so the adapter cannot change domain meaning.
 *   - top-level, queryable index fields (`organizationId`, ids, state, millisecond timestamps...).
 *   - `storedAt`: INFRASTRUCTURE time (when this adapter wrote the document). It is never a domain
 *     timestamp: `occurredAt`/`createdAt`/etc. live inside `json` exactly as the domain produced
 *     them, and nothing reads `storedAt` to decide domain behavior.
 *
 * Tenancy. Tenant-owned documents use the id `<organizationId>~<recordId>` and every read goes
 * through that id (or through an `organizationId ==` filter), so a record id from another tenant
 * does not resolve: the repository answers "not found", exactly like the in-memory ones.
 */

export type FirestoreAdapterOptions = {
  readonly db: Firestore;
  /** Prepended to every collection name; tests and smokes use a unique prefix per run. */
  readonly collectionPrefix?: string;
  /** Infrastructure clock for `storedAt`; injectable for tests. */
  readonly now?: () => Date;
};

export type Ctx = {
  readonly db: Firestore;
  readonly prefix: string;
  readonly now: () => Date;
  col(name: string): CollectionReference<DocumentData>;
};

export function createCtx(options: FirestoreAdapterOptions): Ctx {
  const prefix = options.collectionPrefix ?? "";
  const { db } = options;
  return {
    db,
    prefix,
    now: options.now ?? (() => new Date()),
    col: (name) => db.collection(`${prefix}${name}`),
  };
}

/** Collection names (one place, so docs and indexes agree). */
export const COLLECTIONS = {
  observations: "observations",
  baselines: "baselines",
  baselineSnapshots: "baselineSnapshots",
  baselineAudit: "baselineAudit",
  detectionStates: "detectionStates",
  cases: "cases",
  riskEvents: "riskEvents",
  alerts: "alerts",
  actions: "actions",
  verifications: "verifications",
  interventions: "interventions",
  evidencePackages: "evidencePackages",
  evidencePackageByVerification: "evidencePackageByVerification",
  sharingAgreements: "sharingAgreements",
  sharedEvidence: "sharedEvidence",
  auditEntries: "auditEntries",
  auditCounters: "auditCounters",
  actors: "actors",
  organizations: "organizations",
  identityLinks: "identityLinks",
  devices: "devices",
  replayState: "replayState",
  processedEvents: "processedEvents",
} as const;

/** Tenant-scoped document id. Ids in this system never contain `~` or `/`. */
export function tenantDocId(organizationId: string, recordId: string): string {
  assertSafeIdPart(organizationId);
  assertSafeIdPart(recordId);
  return `${organizationId}~${recordId}`;
}

function assertSafeIdPart(part: string): void {
  if (part === "" || part.includes("/") || part.includes("~") || part === "." || part === "..") {
    throw new Error("unsafe identifier for a Firestore document id");
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Identity-preserving JSON round trip that drops `undefined` (what the domain means by absent). */
export function encode<T>(record: T): string {
  return JSON.stringify(record);
}

export function decode<T>(doc: DocumentData | undefined): T | undefined {
  if (doc === undefined) return undefined;
  const json = doc.json;
  if (typeof json !== "string") throw new Error("stored document has no json payload");
  return JSON.parse(json) as T;
}

export function storedFields(ctx: Ctx): { storedAt: string } {
  return { storedAt: ctx.now().toISOString() };
}

export const ms = (iso: string): number => Date.parse(iso);

/** True for Firestore's ALREADY_EXISTS (gRPC code 6). */
export function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}
