/**
 * Object-store abstraction for evidence package bytes (spec 39: ObjectStore: LocalStore |
 * CloudStorageStore). S6 ships only the in-memory implementation; a Cloud Storage adapter
 * satisfying this interface arrives in S9. Packages are immutable: there is no overwrite and no
 * delete in the interface.
 */
export interface EvidenceObjectStore {
  /** Writes only if `key` is absent. Returns false, writing nothing, when it already exists. */
  putIfAbsent(key: string, content: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
}

export class InMemoryEvidenceObjectStore implements EvidenceObjectStore {
  private readonly objects = new Map<string, string>();

  async putIfAbsent(key: string, content: string): Promise<boolean> {
    if (this.objects.has(key)) return false;
    this.objects.set(key, content);
    return true;
  }

  async get(key: string): Promise<string | undefined> {
    return this.objects.get(key);
  }

  /** Test aid for tamper tests: replaces stored bytes, which the real interface cannot do. */
  tamperForTest(key: string, content: string): void {
    this.objects.set(key, content);
  }
}

export function evidenceObjectKey(organizationId: string, packageId: string): string {
  return `evidence/${organizationId}/${packageId}.json`;
}
