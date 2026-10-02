import type { DocumentData, Query } from "@google-cloud/firestore";
import type {
  DocIndex,
  ListFilter,
  TenantCollection,
  TenantDocumentStore,
  UpdateResult,
} from "@symbiosis/repositories";
import { assertSafeDocId, toPlainJson } from "@symbiosis/repositories";
import { createCtx, decode, encode, isAlreadyExists, storedFields, tenantDocId } from "./common";
import type { Ctx, FirestoreAdapterOptions } from "./common";

/**
 * Firestore implementation of the tenant document store (S10, D-091). One document per record:
 * `json` is the exact plain-JSON record, `organizationId` scopes every read, and each index field
 * is stored as `ix_<name>`. All filters are equality-only, so no composite index is needed.
 * A document id from another organization resolves to "not found" because every id is
 * `<organizationId>~<id>`.
 */
export class FirestoreTenantDocumentStore implements TenantDocumentStore {
  private readonly ctx: Ctx;

  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  private ref(collection: TenantCollection, org: string, id: string) {
    assertSafeDocId(id);
    return this.ctx.col(collection).doc(tenantDocId(org, id));
  }

  private fields(org: string, id: string, doc: unknown, index: DocIndex = {}): DocumentData {
    const flat: DocumentData = {};
    for (const [k, v] of Object.entries(index)) flat[`ix_${k}`] = v;
    return {
      organizationId: org,
      docId: id,
      json: encode(toPlainJson(doc)),
      ...flat,
      ...storedFields(this.ctx),
    };
  }

  async create(
    collection: TenantCollection,
    org: string,
    id: string,
    doc: unknown,
    index?: DocIndex,
  ): Promise<boolean> {
    try {
      await this.ref(collection, org, id).create(this.fields(org, id, doc, index));
      return true;
    } catch (e) {
      if (isAlreadyExists(e)) return false;
      throw e;
    }
  }

  async put(
    collection: TenantCollection,
    org: string,
    id: string,
    doc: unknown,
    index?: DocIndex,
  ): Promise<void> {
    await this.ref(collection, org, id).set(this.fields(org, id, doc, index));
  }

  async get<T>(collection: TenantCollection, org: string, id: string): Promise<T | undefined> {
    const snap = await this.ref(collection, org, id).get();
    return snap.exists ? decode<T>(snap.data()) : undefined;
  }

  async update<T>(
    collection: TenantCollection,
    org: string,
    id: string,
    fn: (current: T | undefined) => UpdateResult<T> | undefined,
  ): Promise<T | undefined> {
    const ref = this.ref(collection, org, id);
    return this.ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? decode<T>(snap.data()) : undefined;
      const next = fn(current);
      if (next === undefined) return current;
      const keptIndex: Record<string, string | number | boolean> = {};
      if (next.index === undefined && snap.exists) {
        for (const [k, v] of Object.entries(snap.data() ?? {})) {
          if (k.startsWith("ix_")) keptIndex[k.slice(3)] = v as string | number | boolean;
        }
      }
      tx.set(ref, this.fields(org, id, next.doc, next.index ?? keptIndex));
      return toPlainJson(next.doc);
    });
  }

  private query(collection: TenantCollection, org: string, where?: DocIndex): Query {
    let q: Query = this.ctx.col(collection).where("organizationId", "==", org);
    for (const [k, v] of Object.entries(where ?? {})) q = q.where(`ix_${k}`, "==", v);
    return q;
  }

  async list<T>(
    collection: TenantCollection,
    org: string,
    filter: ListFilter = {},
  ): Promise<readonly T[]> {
    const snap = await this.query(collection, org, filter.where)
      .limit(filter.limit ?? 500)
      .get();
    return snap.docs.map((d) => decode<T>(d.data()) as T);
  }

  async delete(collection: TenantCollection, org: string, id: string): Promise<void> {
    await this.ref(collection, org, id).delete();
  }

  async purge(collection: TenantCollection, org: string, where?: DocIndex): Promise<number> {
    let total = 0;
    for (;;) {
      const snap = await this.query(collection, org, where).limit(300).get();
      if (snap.empty) return total;
      const batch = this.ctx.db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      total += snap.size;
    }
  }
}
