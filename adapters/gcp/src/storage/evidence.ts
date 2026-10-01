import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import type { EvidenceObjectStore } from "@symbiosis/evidence";

/** Minimal object operations the store needs (the real one wraps `@google-cloud/storage`). */
export interface ObjectClient {
  /** Creates the object only if it does not exist. False (nothing written) when it exists. */
  createIfAbsent(name: string, content: string): Promise<boolean>;
  read(name: string): Promise<string | undefined>;
}

// Each segment starts with a non-dot character, so "." and ".." can never appear as segments.
const SEG = "[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}";
const KEY = new RegExp("^evidence/" + SEG + "/" + SEG + "[.]json$");

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Evidence artifacts in a private Cloud Storage bucket.
 *
 * - Keys are produced by `evidenceObjectKey(org, packageId)` from trusted ids; anything else
 *   (path traversal, untrusted file names) is rejected before touching the bucket.
 * - `putIfAbsent` uses the `ifGenerationMatch: 0` precondition, so an existing object is never
 *   overwritten even by a concurrent writer; the interface has no delete.
 * - After a successful write the object is read back and its SHA-256 compared with the bytes we
 *   meant to store. A mismatch throws, so the evidence service reports STORAGE_FAILURE and writes
 *   no index record and no event (an orphan object, never referenced, may remain).
 */
export class GcsEvidenceObjectStore implements EvidenceObjectStore {
  constructor(private readonly objects: ObjectClient) {}

  async putIfAbsent(key: string, content: string): Promise<boolean> {
    if (!KEY.test(key)) throw new Error("evidence object key is not a valid evidence key");
    const created = await this.objects.createIfAbsent(key, content);
    if (!created) return false;
    const back = await this.objects.read(key);
    if (back === undefined || sha(back) !== sha(content)) {
      throw new Error("evidence object failed read-back verification after write");
    }
    return true;
  }

  async get(key: string): Promise<string | undefined> {
    if (!KEY.test(key)) return undefined;
    return this.objects.read(key);
  }
}

/** Real client: one private bucket. Objects are written `application/json`, never made public. */
export function createGcsObjectClient(projectId: string, bucketName: string): ObjectClient {
  const bucket = new Storage({ projectId }).bucket(bucketName);
  return {
    async createIfAbsent(name, content) {
      try {
        await bucket.file(name).save(content, {
          contentType: "application/json",
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          validation: "md5",
        });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 412) return false;
        throw e;
      }
    },
    async read(name) {
      try {
        const [data] = await bucket.file(name).download();
        return data.toString("utf8");
      } catch (e) {
        if ((e as { code?: number }).code === 404) return undefined;
        throw e;
      }
    },
  };
}

/** Read-only existence probe (needs only `storage.objects.get`): used by startup and readiness. */
export function createBucketProbe(
  projectId: string,
  bucketName: string,
): { exists(name: string): Promise<boolean> } {
  const bucket = new Storage({ projectId }).bucket(bucketName);
  return {
    async exists(name) {
      const [exists] = await bucket.file(name).exists();
      return exists;
    },
  };
}
