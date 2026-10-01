import { PubSub } from "@google-cloud/pubsub";
import { OAuth2Client } from "google-auth-library";
import type { PushAuthVerifier, TopicPublisher } from "./bus";

/** Real topic publisher. Message batching is off so each publish call maps to one accepted message. */
export function createTopicPublisher(projectId: string, topicName: string): TopicPublisher {
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(topicName, { batching: { maxMessages: 1, maxMilliseconds: 0 } });
  return {
    publish: (data, attributes) => topic.publishMessage({ data, attributes }),
  };
}

/**
 * Verifies the OIDC token Pub/Sub attaches to a push delivery: Google-signed, the expected audience
 * (the worker's URL) and the expected push service account, with a verified email. Cloud Run also
 * enforces `roles/run.invoker` before the request reaches the container; this is defense in depth.
 */
export function createPushAuthVerifier(options: {
  readonly audience: string;
  readonly serviceAccountEmail: string;
  readonly client?: Pick<OAuth2Client, "verifyIdToken">;
}): PushAuthVerifier {
  const client = options.client ?? new OAuth2Client();
  return async (header) => {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (match === null || match[1] === undefined) return false;
    const ticket = await client.verifyIdToken({ idToken: match[1], audience: options.audience });
    const payload = ticket.getPayload();
    return payload?.email === options.serviceAccountEmail && payload.email_verified === true;
  };
}
