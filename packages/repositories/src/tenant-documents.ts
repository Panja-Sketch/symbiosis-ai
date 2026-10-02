/**
 * Tenant-scoped document store (S10, D-091). The S10 control-plane and notification state (simulation
 * sessions, versioned policies and adapter mappings, delivery records, contacts, read models) is a
 * set of small, plain-JSON documents that need the same few operations, so they share one port
 * instead of one hand-written repository each. The Firestore adapter implements the same interface
 * and the shared contract suite runs against both.
 *
 * Every operation is organization-scoped: a document id from another organization resolves to
 * "not found". Documents are plain JSON (checked on write); `index` fields are the only queryable
 * attributes.
 */
export const TENANT_COLLECTIONS = [
  "simulationControl",
  "simulationSessions",
  "simulationStates",
  "simulationPolicyVersions",
  "simulationPolicyActive",
  "adapterMappingVersions",
  "adapterMappingActive",
  "adapterTraces",
  "notificationDeliveries",
  "followUpState",
  "contacts",
  "ruleEvaluations",
  "weatherCache",
] as const;
export type TenantCollection = (typeof TENANT_COLLECTIONS)[number];

export type DocIndex = Readonly<Record<string, string | number | boolean>>;

export type ListFilter = {
  readonly where?: DocIndex;
  /** Maximum documents returned (default 500). Order is unspecified; callers sort. */
  readonly limit?: number;
};

export type UpdateResult<T> = { readonly doc: T; readonly index?: DocIndex };

export interface TenantDocumentStore {
  /** Creates the document; false (nothing written) when the id already exists. Atomic. */
  create(
    collection: TenantCollection,
    organizationId: string,
    id: string,
    doc: unknown,
    index?: DocIndex,
  ): Promise<boolean>;
  /** Creates or replaces. */
  put(
    collection: TenantCollection,
    organizationId: string,
    id: string,
    doc: unknown,
    index?: DocIndex,
  ): Promise<void>;
  get<T>(collection: TenantCollection, organizationId: string, id: string): Promise<T | undefined>;
  /**
   * Atomic read-modify-write. `fn` sees the current document (or undefined) and returns the new
   * one, or undefined to leave it untouched. It may run more than once and must be pure.
   * Resolves to the document that is stored afterwards.
   */
  update<T>(
    collection: TenantCollection,
    organizationId: string,
    id: string,
    fn: (current: T | undefined) => UpdateResult<T> | undefined,
  ): Promise<T | undefined>;
  list<T>(
    collection: TenantCollection,
    organizationId: string,
    filter?: ListFilter,
  ): Promise<readonly T[]>;
  delete(collection: TenantCollection, organizationId: string, id: string): Promise<void>;
  /** Deletes every matching document of the organization; returns how many. Used by simulation reset. */
  purge(collection: TenantCollection, organizationId: string, where?: DocIndex): Promise<number>;
}

/** Plain-JSON round trip: rejects anything JSON would silently change (undefined, Date, NaN, functions). */
export function toPlainJson<T>(doc: T): T {
  const text = JSON.stringify(doc, (_k, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("non-finite number in document");
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
      throw new Error("non-JSON value in document");
    }
    return v;
  });
  if (text === undefined) throw new Error("document is not JSON");
  return JSON.parse(text) as T;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@#:-]{0,199}$/;
export function assertSafeDocId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("unsafe document id");
}

export class InMemoryTenantDocumentStore implements TenantDocumentStore {
  private readonly docs = new Map<
    string,
    { doc: string; index: DocIndex; org: string; c: string }
  >();

  private key(c: TenantCollection, org: string, id: string): string {
    assertSafeDocId(id);
    return `${c}|${org}|${id}`;
  }

  async create(c: TenantCollection, org: string, id: string, doc: unknown, index: DocIndex = {}) {
    const k = this.key(c, org, id);
    if (this.docs.has(k)) return false;
    this.docs.set(k, { doc: JSON.stringify(toPlainJson(doc)), index, org, c });
    return true;
  }

  async put(c: TenantCollection, org: string, id: string, doc: unknown, index: DocIndex = {}) {
    this.docs.set(this.key(c, org, id), {
      doc: JSON.stringify(toPlainJson(doc)),
      index,
      org,
      c,
    });
  }

  async get<T>(c: TenantCollection, org: string, id: string): Promise<T | undefined> {
    const e = this.docs.get(this.key(c, org, id));
    return e === undefined ? undefined : (JSON.parse(e.doc) as T);
  }

  async update<T>(
    c: TenantCollection,
    org: string,
    id: string,
    fn: (current: T | undefined) => UpdateResult<T> | undefined,
  ): Promise<T | undefined> {
    // No await between the read and the write: atomic on a single thread.
    const k = this.key(c, org, id);
    const e = this.docs.get(k);
    const current = e === undefined ? undefined : (JSON.parse(e.doc) as T);
    const next = fn(current);
    if (next === undefined) return current;
    this.docs.set(k, {
      doc: JSON.stringify(toPlainJson(next.doc)),
      index: next.index ?? e?.index ?? {},
      org,
      c,
    });
    return JSON.parse(this.docs.get(k)?.doc ?? "null") as T;
  }

  async list<T>(c: TenantCollection, org: string, filter: ListFilter = {}): Promise<readonly T[]> {
    const out: T[] = [];
    const limit = filter.limit ?? 500;
    for (const e of this.docs.values()) {
      if (e.c !== c || e.org !== org) continue;
      if (filter.where !== undefined) {
        if (!Object.entries(filter.where).every(([k, v]) => e.index[k] === v)) continue;
      }
      out.push(JSON.parse(e.doc) as T);
      if (out.length >= limit) break;
    }
    return out;
  }

  async delete(c: TenantCollection, org: string, id: string) {
    this.docs.delete(this.key(c, org, id));
  }

  async purge(c: TenantCollection, org: string, where?: DocIndex): Promise<number> {
    let n = 0;
    for (const [k, e] of [...this.docs.entries()]) {
      if (e.c !== c || e.org !== org) continue;
      if (where !== undefined && !Object.entries(where).every(([kk, v]) => e.index[kk] === v))
        continue;
      this.docs.delete(k);
      n += 1;
    }
    return n;
  }
}
