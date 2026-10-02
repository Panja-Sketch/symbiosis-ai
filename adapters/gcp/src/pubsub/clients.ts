import { PubSub } from "@google-cloud/pubsub";
import { OAuth2Client } from "google-auth-library";
import type { PushAuthVerifier, TopicPublisher } from "./bus";

/**
 * Real topic publisher. Message batching is off so each publish call maps to one accepted message.
 * Message ordering is on: strict ordering needs the regional endpoint of the topic's region, and a
 * failed publish pauses its ordering key until it is resumed, so a failure is resumed here and then
 * reported to the caller (which never believes an event was emitted when it was not).
 */
export function createTopicPublisher(
  projectId: string,
  topicName: string,
  region?: string,
): TopicPublisher {
  const pubsub = new PubSub({
    projectId,
    ...(region !== undefined && { apiEndpoint: `${region}-pubsub.googleapis.com:443` }),
  });
  const topic = pubsub.topic(topicName, {
    batching: { maxMessages: 1, maxMilliseconds: 0 },
    messageOrdering: true,
  });
  return {
    publish: async (data, attributes, orderingKey) => {
      try {
        return await topic.publishMessage({
          data,
          attributes,
          ...(orderingKey !== undefined && { orderingKey }),
        });
      } catch (e) {
        if (orderingKey !== undefined) topic.resumePublishing(orderingKey);
        throw e;
      }
    },
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
