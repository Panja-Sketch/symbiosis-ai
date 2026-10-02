import { GoogleWeatherProvider } from "@symbiosis/adapter-weather";
import type { WeatherPolicy } from "@symbiosis/adapter-weather";
import { SmtpEmailNotificationSender } from "@symbiosis/adapter-email";
import {
  createFirestoreFacilityPurge,
  createSecretAccess,
  createSmtpCredentialsReader,
  createWeatherAuthHeaders,
} from "@symbiosis/adapter-gcp";
import type { Firestore } from "@google-cloud/firestore";
import type { Clock } from "@symbiosis/clock";
import type { WeatherProvider } from "@symbiosis/contracts";
import { ConsoleEmail } from "@symbiosis/notifications";
import type { ContactDirectory, NotificationSender } from "@symbiosis/notifications";
import {
  loadAdapterProfiles,
  loadFollowUpPolicy,
  loadPolicyParameters,
  loadRawPolicyBase,
  loadScenarios,
  loadSimulationFacility,
  RuntimeConfigError,
} from "./config";
import type { Env } from "./config";
import type { SimulationOptions } from "./compose";

/**
 * Cloud configuration of the S10 features (D-089, D-090). Everything optional falls back to the
 * honest "not configured" state, never to fake data: no email provider means the console channel is
 * NOT silently used in the cloud (the delivery record says what happened), and no live weather means
 * the weather tile says so.
 *
 * Environment (names only; values are never logged):
 *   SYMBIOSIS_EMAIL_PROVIDER      smtp | console   (default console)
 *   SYMBIOSIS_SMTP_HOST / _PORT / _SECURITY (tls|starttls)   demo transport, e.g. smtp.gmail.com 465 tls
 *   SYMBIOSIS_SMTP_SECRET_NAME    Secret Manager secret holding {"username","password"}
 *   SYMBIOSIS_EMAIL_FROM / SYMBIOSIS_EMAIL_FROM_NAME
 *   SYMBIOSIS_WEATHER_PROVIDER    google | none    (default none)
 *   SYMBIOSIS_WEATHER_AUTH        adc | api-key    (default adc)
 *   SYMBIOSIS_WEATHER_API_KEY_SECRET   secret name when api-key
 *   SYMBIOSIS_WEATHER_CACHE_SECONDS / _MAX_CALLS_PER_DAY
 *   SYMBIOSIS_WEB_BASE_URL        link base for emails
 *   SYMBIOSIS_WORKER_URL          (api) where "run the checks now" asks the worker
 */
export type S10CloudConfig = {
  readonly email:
    | { readonly provider: "console" }
    | {
        readonly provider: "smtp";
        readonly host: string;
        readonly port: number;
        readonly security: "tls" | "starttls";
        readonly secretName: string;
        readonly from?: string;
        readonly fromName: string;
      };
  readonly weather: {
    readonly provider: "google" | "none";
    readonly auth: "adc" | "api-key";
    readonly apiKeySecret?: string;
    readonly policy: WeatherPolicy;
  };
  readonly webBaseUrl?: string;
  readonly workerUrl?: string;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export function parseS10CloudConfig(env: Env): S10CloudConfig {
  const problems: string[] = [];
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  const provider = env.SYMBIOSIS_EMAIL_PROVIDER ?? "console";
  let email: S10CloudConfig["email"] = { provider: "console" };
  if (provider === "smtp") {
    const host = env.SYMBIOSIS_SMTP_HOST ?? "";
    const security = env.SYMBIOSIS_SMTP_SECURITY ?? "tls";
    const secretName = env.SYMBIOSIS_SMTP_SECRET_NAME ?? "";
    const from = env.SYMBIOSIS_EMAIL_FROM ?? "";
    if (!HOST.test(host)) problems.push("SYMBIOSIS_SMTP_HOST is required for the smtp provider");
    if (security !== "tls" && security !== "starttls") problems.push("SYMBIOSIS_SMTP_SECURITY must be tls or starttls");
    if (!NAME.test(secretName)) problems.push("SYMBIOSIS_SMTP_SECRET_NAME is required for the smtp provider");
    if (from !== "" && !EMAIL.test(from)) problems.push("SYMBIOSIS_EMAIL_FROM is not an email address");
    email = {
      provider: "smtp",
      host,
      port: num("SYMBIOSIS_SMTP_PORT", security === "starttls" ? 587 : 465, 1, 65535),
      security: security === "starttls" ? "starttls" : "tls",
      secretName,
      ...(from !== "" && { from }),
      fromName: env.SYMBIOSIS_EMAIL_FROM_NAME ?? "Symbiosis AI",
    };
  } else if (provider !== "console") {
    problems.push("SYMBIOSIS_EMAIL_PROVIDER must be smtp or console");
  }
  const weatherProvider = env.SYMBIOSIS_WEATHER_PROVIDER ?? "none";
  if (weatherProvider !== "google" && weatherProvider !== "none") {
    problems.push("SYMBIOSIS_WEATHER_PROVIDER must be google or none");
  }
  const auth = env.SYMBIOSIS_WEATHER_AUTH ?? "adc";
  if (auth !== "adc" && auth !== "api-key") problems.push("SYMBIOSIS_WEATHER_AUTH must be adc or api-key");
  const keySecret = env.SYMBIOSIS_WEATHER_API_KEY_SECRET ?? "";
  if (auth === "api-key" && weatherProvider === "google" && !NAME.test(keySecret)) {
    problems.push("SYMBIOSIS_WEATHER_API_KEY_SECRET is required for api-key authentication");
  }
  const webBaseUrl = env.SYMBIOSIS_WEB_BASE_URL ?? "";
  if (webBaseUrl !== "" && !/^https?:\/\/[^\s]+$/.test(webBaseUrl)) problems.push("SYMBIOSIS_WEB_BASE_URL must be a URL");
  const workerUrl = env.SYMBIOSIS_WORKER_URL ?? "";
  if (workerUrl !== "" && !/^https:\/\/[^\s]+$/.test(workerUrl)) problems.push("SYMBIOSIS_WORKER_URL must be an https URL");
  const policy: WeatherPolicy = {
    cacheTtlSeconds: num("SYMBIOSIS_WEATHER_CACHE_SECONDS", 600, 60, 3600),
    failureBackoffSeconds: 120,
    maxFetchesPerDay: num("SYMBIOSIS_WEATHER_MAX_CALLS_PER_DAY", 100, 1, 2000),
    staleAfterSeconds: 3600,
  };
  if (problems.length > 0) throw new RuntimeConfigError(problems);
  return {
    email,
    weather: {
      provider: weatherProvider === "google" ? "google" : "none",
      auth: auth === "api-key" ? "api-key" : "adc",
      ...(keySecret !== "" && { apiKeySecret: keySecret }),
      policy,
    },
    ...(webBaseUrl !== "" && { webBaseUrl }),
    ...(workerUrl !== "" && { workerUrl }),
  };
}

/** The alert channel for the cloud: SMTP when configured, otherwise the (logging) console channel. */
export function createCloudNotificationSender(options: {
  readonly config: S10CloudConfig;
  readonly projectId: string;
  readonly clock: Clock;
  readonly contacts: ContactDirectory;
  readonly log: (line: string) => void;
}): NotificationSender {
  const { email } = options.config;
  if (email.provider === "console") return new ConsoleEmail(options.clock, options.log);
  const secrets = createSecretAccess(options.projectId);
  const credentials = createSmtpCredentialsReader(secrets, email.secretName);
  return new SmtpEmailNotificationSender({
    clock: options.clock,
    contacts: options.contacts,
    smtp: { host: email.host, port: email.port, security: email.security },
    credentials,
    from: async () => email.from ?? (await credentials()).username,
    fromName: email.fromName,
  });
}

export function createCloudWeatherProvider(options: {
  readonly config: S10CloudConfig;
  readonly projectId: string;
  readonly clock: Clock;
}): WeatherProvider | undefined {
  const { weather } = options.config;
  if (weather.provider === "none") return undefined;
  return new GoogleWeatherProvider({
    clock: options.clock,
    authHeaders: createWeatherAuthHeaders({
      mode: weather.auth,
      projectId: options.projectId,
      ...(weather.auth === "api-key" && {
        secrets: createSecretAccess(options.projectId),
        apiKeySecretId: weather.apiKeySecret ?? "",
      }),
    }),
  });
}

/** The simulation options for a cloud service (facility, scenarios, policy files, purge, weather). */
export function cloudSimulationOptions(options: {
  readonly config: S10CloudConfig;
  readonly projectId: string;
  readonly clock: Clock;
  readonly firestore: Firestore;
  readonly collectionPrefix: string;
  readonly env?: Env;
}): SimulationOptions {
  const live = createCloudWeatherProvider(options);
  return {
    facility: loadSimulationFacility(options.env),
    scenarios: loadScenarios(options.env),
    parameters: loadPolicyParameters(options.env),
    rawBase: loadRawPolicyBase(options.env),
    weather: { policy: options.config.weather.policy, ...(live !== undefined && { live }) },
    purge: createFirestoreFacilityPurge({ db: options.firestore, collectionPrefix: options.collectionPrefix }),
  };
}

export { loadAdapterProfiles, loadFollowUpPolicy };
