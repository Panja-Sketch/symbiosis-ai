import { createEdgeServer, listen } from "@symbiosis/api";
import type { EdgeRequest, EdgeResponse } from "@symbiosis/api";
import { JsonLogger, createPushAuthVerifier, createPushHandler } from "@symbiosis/adapter-gcp";
import type { Logger } from "@symbiosis/adapter-gcp";
import { SystemClock } from "@symbiosis/clock";
import { RandomIdGenerator } from "@symbiosis/event-bus";
import { StoreContactDirectory } from "@symbiosis/notifications";
import { composeServices } from "./compose";
import {
  cloudSimulationOptions,
  createCloudNotificationSender,
  parseS10CloudConfig,
} from "./cloud-s10";
import {
  RuntimeConfigError,
  loadActionLibrary,
  loadAdapterProfiles,
  loadBaselineConfig,
  loadFollowUpPolicy,
  loadDataQualityConfig,
  loadEscalationPolicy,
  loadInterventionPolicy,
  loadRuleConfig,
  loadVerificationPolicy,
  parseRuntimeConfig,
} from "./config";
import { createGcpPlatform } from "./gcp";
import { withHealth, withRequestLogging } from "./http";

/**
 * Cloud Run entrypoint for the worker (S9). The worker is PRIVATE (no public invoker): only the
 * Pub/Sub push identity may deliver events to `POST /pubsub/push` and only the Cloud Scheduler
 * identity may call `POST /tick`. Both are also verified in-process (OIDC audience + service
 * account email). Concurrency is 1 and a single instance serializes processing, which keeps the
 * S2-S8 ordering assumptions; handlers are idempotent regardless (delivery is at least once).
 */
async function main(): Promise<void> {
  const base = new JsonLogger({ component: "worker" });
  const die = (message: string, error: unknown): void => {
    base.log("ERROR", message, { error });
    process.exitCode = 1;
  };
  let config;
  try {
    config = parseRuntimeConfig(process.env, "worker");
    if (config.mode !== "gcp" || config.worker === undefined) {
      throw new RuntimeConfigError(["the worker service requires SYMBIOSIS_RUNTIME=gcp"]);
    }
  } catch (e) {
    return die("invalid runtime configuration", e);
  }
  const worker = config.worker;
  if (worker === undefined) return;
  const logger: Logger = base.child({ version: config.version });
  const platform = createGcpPlatform(config, logger);
  try {
    await platform.verifyStartup();
  } catch (e) {
    return die("startup verification failed", e);
  }

  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  let s10;
  try {
    s10 = parseS10CloudConfig(process.env);
  } catch (e) {
    return die("invalid S10 configuration", e);
  }
  const services = composeServices(platform.ports, {
    clock,
    ids,
    // Alerts, escalations and follow-ups are sent by the worker: SMTP when configured.
    notificationSender: createCloudNotificationSender({
      config: s10,
      projectId: config.projectId,
      clock,
      contacts: new StoreContactDirectory(platform.ports.documents),
      log: (line) => logger.log("INFO", "notification", { component: "worker", line }),
    }),
    adapterProfiles: loadAdapterProfiles(),
    ...(s10.webBaseUrl !== undefined && { webBaseUrl: s10.webBaseUrl }),
    simulation: cloudSimulationOptions({
      config: s10,
      projectId: config.projectId,
      clock,
      firestore: platform.firestore,
      collectionPrefix: config.collectionPrefix,
    }),
    policies: {
      escalation: loadEscalationPolicy(),
      actionLibrary: loadActionLibrary(),
      verification: loadVerificationPolicy(),
      intervention: loadInterventionPolicy(),
      baseline: loadBaselineConfig(),
      rule: loadRuleConfig(),
      dataQuality: loadDataQualityConfig(),
      followUp: loadFollowUpPolicy(),
    },
  });
  services.startConsumers();

  const push = createPushHandler({
    bus: platform.bus,
    inbox: platform.inbox,
    logger,
    verifyCaller: createPushAuthVerifier({
      audience: worker.audience,
      serviceAccountEmail: worker.pushServiceAccount,
    }),
  });
  const verifyScheduler = createPushAuthVerifier({
    audience: worker.audience,
    serviceAccountEmail: worker.schedulerServiceAccount,
  });
  // The API may also ask for one pass ("run the checks now" in the simulation workspace). It must
  // authenticate as its own service identity; the worker still verifies the token.
  const apiAccount = process.env.SYMBIOSIS_API_SERVICE_ACCOUNT ?? "";
  const verifyApi =
    apiAccount === ""
      ? undefined
      : createPushAuthVerifier({ audience: worker.audience, serviceAccountEmail: apiAccount });

  const app = async (request: EdgeRequest): Promise<EdgeResponse> => {
    const path = request.target.split("?")[0];
    if (path === "/pubsub/push") return push(request);
    if (path === "/tick") {
      if (request.method.toUpperCase() !== "POST") {
        return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED" } } };
      }
      let allowed = false;
      try {
        allowed = await verifyScheduler(request.headers.authorization);
        if (!allowed && verifyApi !== undefined)
          allowed = await verifyApi(request.headers.authorization);
      } catch {
        allowed = false;
      }
      if (!allowed) return { status: 401, body: { error: { code: "UNAUTHENTICATED" } } };
      try {
        const result = await services.tick();
        logger.log("INFO", "tick completed", {
          component: "worker",
          escalated: result.escalated.length,
          retried: result.retried,
          verificationStarted: result.verification.started.length,
          verificationCompleted: result.verification.completed.length,
          verificationFailures: result.verification.failures.length,
          followUpsRequested: result.followUps.requested,
        });
        return { status: 200, body: { status: "ok" } };
      } catch (e) {
        logger.log("ERROR", "tick failed", { component: "worker", error: e });
        return { status: 500, body: { error: { code: "TICK_FAILED" } } };
      }
    }
    return { status: 404, body: { error: { code: "NOT_FOUND" } } };
  };

  const handler = withRequestLogging(
    withHealth(app, {
      role: "worker",
      version: config.version,
      readiness: () => platform.readiness(),
    }),
    logger,
    "worker",
  );
  const port = Number(process.env.PORT ?? 8080);
  const server = await listen(createEdgeServer(handler), port, "0.0.0.0");
  logger.log("INFO", "worker listening", { component: "worker", port: server.port });
  const stop = () => {
    void server.close().then(() => platform.close());
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  process.stderr.write(`worker failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
