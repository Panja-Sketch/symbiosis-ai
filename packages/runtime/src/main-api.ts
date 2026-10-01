import {
  createApiHandler,
  createAppHandler,
  createEdgeHandler,
  createEdgeServer,
  createInsuranceHandler,
  listen,
} from "@symbiosis/api";
import { JsonLogger } from "@symbiosis/adapter-gcp";
import { SystemClock } from "@symbiosis/clock";
import { RandomIdGenerator } from "@symbiosis/event-bus";
import { ConsoleEmail } from "@symbiosis/notifications";
import { composeServices } from "./compose";
import {
  RuntimeConfigError,
  loadActionLibrary,
  loadBaselineConfig,
  loadDataQualityConfig,
  loadEscalationPolicy,
  loadInterventionPolicy,
  loadRuleConfig,
  loadVerificationPolicy,
  parseRuntimeConfig,
} from "./config";
import { createCloudExplanationService, createGcpPlatform } from "./gcp";
import { withHealth, withRequestLogging } from "./http";

/**
 * Cloud Run entrypoint for the API (S9). Production only: the process refuses to start unless the
 * gcp configuration is complete and every critical adapter answers, so it can never run on
 * in-memory stand-ins. Identity is Firebase only (no demo header, no `/ui` pages, no dev identity
 * listing). The API registers NO event consumers: it publishes to Pub/Sub, the worker consumes.
 */
const fatal = (logger: JsonLogger, message: string, error: unknown): never => {
  logger.log("ERROR", message, { error });
  process.exitCode = 1;
  throw error instanceof Error ? error : new Error(message);
};

async function main(): Promise<void> {
  const base = new JsonLogger({ component: "api" });
  let config;
  try {
    config = parseRuntimeConfig(process.env, "api");
    if (config.mode !== "gcp") {
      throw new RuntimeConfigError(["the api service requires SYMBIOSIS_RUNTIME=gcp"]);
    }
  } catch (e) {
    return fatal(base, "invalid runtime configuration", e);
  }
  const logger = base.child({ version: config.version });
  const platform = createGcpPlatform(config, logger);
  try {
    await platform.verifyStartup();
  } catch (e) {
    return fatal(base, "startup verification failed", e);
  }

  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const services = composeServices(platform.ports, {
    clock,
    ids,
    notificationSender: new ConsoleEmail(clock, (line) =>
      logger.log("INFO", "notification", { component: "api", line }),
    ),
    policies: {
      escalation: loadEscalationPolicy(),
      actionLibrary: loadActionLibrary(),
      verification: loadVerificationPolicy(),
      intervention: loadInterventionPolicy(),
      baseline: loadBaselineConfig(),
      rule: loadRuleConfig(),
      dataQuality: loadDataQualityConfig(),
    },
  });
  const explanations = createCloudExplanationService({
    config,
    env: process.env,
    accessToken: platform.accessToken,
    clock,
    ids,
    logger,
  });

  const edge = createEdgeHandler({
    registry: platform.ports.registry,
    keys: platform.ports.keys,
    replayGuard: platform.ports.replayGuard,
    bus: platform.bus,
    clock,
    ids,
    log: (entry) =>
      logger.log(entry.level === "warn" ? "WARNING" : "INFO", entry.message, {
        component: "api",
        ...entry.fields,
      }),
  });
  const app = createAppHandler({
    operations: services.operations,
    interventions: services.interventionService,
    evidence: services.evidenceService,
    sharing: services.sharingService,
    insurance: services.insuranceGateway,
    directory: platform.ports.directory,
    identity: platform.identity,
    explanations,
  });
  const insurance = createInsuranceHandler({
    gateway: services.insuranceGateway,
    directory: platform.ports.directory,
    identity: platform.identity,
    explanations,
  });
  const handler = withRequestLogging(
    withHealth(createApiHandler({ edge, app, insurance }), {
      role: "api",
      version: config.version,
      readiness: () => platform.readiness(),
    }),
    logger,
    "api",
  );

  const port = Number(process.env.PORT ?? 8080);
  const server = await listen(createEdgeServer(handler), port, "0.0.0.0");
  logger.log("INFO", "api listening", { component: "api", port: server.port });
  const stop = () => {
    void server.close().then(() => platform.close());
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch(() => {
  process.exitCode = process.exitCode ?? 1;
});
