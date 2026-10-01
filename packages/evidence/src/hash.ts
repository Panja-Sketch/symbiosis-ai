import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Lower-case hex SHA-256 of the canonical form of `value`. */
export function sha256OfCanonical(value: unknown): string {
  return sha256OfText(canonicalJson(value));
}
