import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type {
  ActorContext,
  ActorDirectory,
  IdentityRequest,
  IdentityResolver,
} from "@symbiosis/tenancy";
import type { IdentityLinkStore } from "../firestore/platform";
import type { Logger } from "../logger";
import { nullLogger } from "../logger";

/** A verified token reduced to what the resolver may use. Nothing else is trusted. */
export type VerifiedIdentity = { readonly uid: string };

/**
 * Verifies a Firebase ID token and returns the UID, or throws. The real implementation is the
 * Firebase Admin SDK's `verifyIdToken` (signature against Google's rotating keys, issuer, audience
 * = our project, expiry, subject), with revocation checking on.
 */
export type TokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

export function createFirebaseTokenVerifier(options: {
  readonly projectId: string;
  readonly checkRevoked?: boolean;
}): TokenVerifier {
  const name = `symbiosis-${options.projectId}`;
  const app =
    getApps().find((a) => a.name === name) ?? initializeApp({ projectId: options.projectId }, name);
  const auth = getAuth(app);
  return async (idToken) => {
    const decoded = await auth.verifyIdToken(idToken, options.checkRevoked ?? true);
    if (typeof decoded.uid !== "string" || decoded.uid === "") throw new Error("token has no uid");
    return { uid: decoded.uid };
  };
}

const MAX_TOKEN_LENGTH = 8192;

/**
 * Production identity (S9): browser -> Firebase sign-in -> ID token -> `Authorization: Bearer` ->
 * VERIFIED server-side -> Firebase UID -> trusted link -> canonical actor -> directory record.
 *
 * What the request can influence is only the token. Organization, facility scope and roles come
 * from the Firestore actor record reached through the UID link, never from the token body (custom
 * claims are not used), headers, query or body. Any failure (missing/malformed header, verification
 * error, unlinked UID, unknown or disabled actor) yields `undefined`, i.e. unauthenticated.
 */
export class FirebaseIdentityResolver implements IdentityResolver {
  readonly kind = "token" as const;

  constructor(
    private readonly deps: {
      readonly verify: TokenVerifier;
      readonly links: IdentityLinkStore;
      readonly directory: ActorDirectory;
      readonly logger?: Logger;
    },
  ) {}

  async resolve(request: IdentityRequest): Promise<ActorContext | undefined> {
    const log = this.deps.logger ?? nullLogger;
    const header = request.headers.authorization;
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    const token = match?.[1];
    if (token === undefined || token.length > MAX_TOKEN_LENGTH) return undefined;
    let uid: string;
    try {
      uid = (await this.deps.verify(token)).uid;
    } catch (e) {
      log.log("WARNING", "id token rejected", {
        component: "api",
        reason: (e as { code?: string }).code ?? "VERIFICATION_FAILED",
      });
      return undefined;
    }
    try {
      const actorId = await this.deps.links.actorIdForUid(uid);
      if (actorId === undefined) {
        log.log("WARNING", "verified uid has no actor link", { component: "api" });
        return undefined;
      }
      return await this.deps.directory.get(actorId);
    } catch (e) {
      // Directory/Firestore unavailable: deny rather than guess.
      log.log("ERROR", "identity lookup failed", { component: "api", error: e });
      return undefined;
    }
  }
}
