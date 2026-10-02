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
import { createWorkerTickInvoker } from "@symbiosis/adapter-gcp";
import { composeServices } from "./compose";
import { cloudSimulationOptions, parseS10CloudConfig } from "./cloud-s10";
import { createSimulationHttp } from "./simulation-http";
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
  let s10;
  try {
    s10 = parseS10CloudConfig(process.env);
  } catch (e) {
    return fatal(base, "invalid S10 configuration", e);
  }
  const services = composeServices(platform.ports, {
    clock,
    ids,
    adapterProfiles: loadAdapterProfiles(),
    ...(s10.webBaseUrl !== undefined && { webBaseUrl: s10.webBaseUrl }),
    simulation: cloudSimulationOptions({
      config: s10,
      projectId: config.projectId,
      clock,
      firestore: platform.firestore,
      collectionPrefix: config.collectionPrefix,
    }),
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
      followUp: loadFollowUpPolicy(),
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
    adapters: services.catalog,
    log: (entry) =>
      logger.log(entry.level === "warn" ? "WARNING" : "INFO", entry.message, {
        component: "api",
        ...entry.fields,
      }),
  });
  // The simulation reaches the platform exactly as a customer's gateway does: signed bytes sent to
  // the edge boundary (here an in-process call of the very same handler the public route uses).
  const http = createSimulationHttp({
    services,
    ports: platform.ports,
    clock,
    ids,
    submit: async (r) => {
      const res = await edge({
        method: r.method,
        target: r.target,
        headers: r.headers,
        rawBody: r.rawBody,
      });
      return { status: res.status, body: res.body };
    },
    ...(s10.workerUrl !== undefined && { tick: createWorkerTickInvoker(s10.workerUrl) }),
  });
  const app = createAppHandler({
    ...(http.simulation !== undefined && { simulation: http.simulation }),
    contacts: http.contacts,
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
