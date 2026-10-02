/**
 * The Facility Simulation HTTP contract as the web app sees it (`/api/v1/simulation/*`). The web app
 * imports no domain package; these shapes mirror what the API returns. Every state, status and
 * conclusion shown here is decided by the backend; the browser only displays it.
 */
import type { CaseDto } from "./types";

export type SensorStatus = "NORMAL" | "WARNING" | "CRITICAL" | "LEARNING" | "NO_DATA" | "UNTRUSTED";
export type WeatherStatus = "LIVE" | "SIMULATED" | "STALE" | "UNAVAILABLE" | "NOT_CONFIGURED";
export type SensorHealth = "HEALTHY" | "DEGRADED" | "FAULT";
export type SensorGroupId = "hvac" | "vibration" | "meter";

export type SensorCondition = {
  readonly health: SensorHealth;
  readonly staleSeconds: number;
  readonly dropout: boolean;
};

export type PhysicalValues = {
  readonly zoneTemperatureC: number;
  readonly relativeHumidityPct: number;
  readonly vibrationRmsMs2: number;
  readonly currentA: number;
  readonly loadPercent: number;
  readonly primaryRunning: boolean;
  readonly backupRunning: boolean;
  readonly outdoorTemperatureC: number;
  readonly sensors: Readonly<Record<SensorGroupId, SensorCondition>>;
};

export type NumericField =
  | "zoneTemperatureC"
  | "relativeHumidityPct"
  | "vibrationRmsMs2"
  | "currentA"
  | "loadPercent"
  | "outdoorTemperatureC";

export type FieldBound = {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  readonly label: string;
};

export type SimSensor = {
  readonly sensorId: string;
  readonly name: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly signal: string;
  readonly group: string;
  readonly value: number | boolean | null;
  readonly unit: string;
  readonly observedAt: string | null;
  readonly ageSeconds: number | null;
  readonly confidence: number | null;
  readonly trusted: boolean | null;
  readonly trustNote: string | null;
  readonly status: SensorStatus;
  readonly sourceType: string | null;
  readonly sourceAdapter: string | null;
  readonly deviceId: string | null;
  readonly sourceLabel: string | null;
  readonly synthetic: boolean | null;
};

export type SimWeather = {
  readonly status: WeatherStatus;
  readonly mode: "LIVE" | "SIMULATED";
  readonly provider: string | null;
  readonly live: boolean;
  readonly reading?: {
    readonly temperatureC: number;
    readonly observedAt: string;
    readonly fetchedAt: string;
    readonly relativeHumidityPct?: number;
    readonly condition?: string;
    readonly windSpeedKph?: number;
  };
  readonly ageSeconds?: number;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly nextRefreshAt?: string;
  readonly callsToday: number;
  readonly maxCallsPerDay: number;
  readonly label: string;
  readonly display: string;
};

export type RuleCondition = {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly operator: string;
  readonly unit: string;
  readonly met: boolean | null;
  readonly source: string;
};

export type RuleView = {
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  readonly evaluatedAt: string | null;
  readonly outcome: "NORMAL" | "WATCH" | "CANDIDATE_RISK" | "INSUFFICIENT_DATA" | null;
  readonly persistence: {
    readonly qualifyingEvaluations: number;
    readonly required: number;
  } | null;
  readonly conditions: readonly RuleCondition[];
  readonly history: readonly {
    readonly at: string;
    readonly outcome: string;
    readonly qualifying: number;
    readonly required: number;
  }[];
};

export type SimDelivery = {
  readonly deliveryId: string;
  readonly kind: string;
  readonly recipientRole: string | null;
  readonly recipientRef: string;
  readonly addressHint: string | null;
  readonly channel: string;
  readonly status: "PENDING" | "SENT" | "FAILED";
  readonly attempt: number;
  readonly subject: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
};

export type SimOverview = {
  readonly facility: {
    readonly facilityId: string;
    readonly name: string;
    readonly description: string;
    readonly location: { readonly label: string };
    readonly assets: readonly {
      readonly assetId: string;
      readonly name: string;
      readonly kind: string;
    }[];
  };
  readonly session: {
    readonly sessionId: string;
    readonly generation: number;
    readonly status: "RUNNING" | "STOPPED";
    readonly scenarioId: string;
    readonly weatherMode: "LIVE" | "SIMULATED";
    readonly startedBy: string;
    readonly startedAt: string;
    readonly revision: number;
    readonly pulses: number;
    readonly emitted: number;
    readonly rejected: number;
    readonly lastPulseAt?: string;
    readonly resets: number;
    readonly clockMode: "REAL_TIME";
  };
  readonly liveness: "LIVE" | "PAUSED" | "STOPPED";
  readonly clock: { readonly mode: "REAL_TIME"; readonly nowIso: string; readonly label: string };
  readonly values: PhysicalValues;
  readonly bounds: {
    readonly numeric: Readonly<Record<NumericField, FieldBound>>;
    readonly staleSecondsMax: number;
    readonly sensorGroups: Readonly<Record<SensorGroupId, string>>;
  };
  readonly scenarios: readonly {
    readonly id: string;
    readonly label: string;
    readonly summary: string;
    readonly world: string;
    readonly expectation: string;
    readonly rampSeconds: number;
    readonly weatherMode: "LIVE" | "SIMULATED";
  }[];
  readonly weather: SimWeather;
  readonly sensors: readonly SimSensor[];
  readonly devices: readonly {
    readonly deviceId: string;
    readonly displayName: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly group: string;
    readonly health: string;
    readonly lastSeenAt: string | null;
    readonly registered: boolean;
  }[];
  readonly baseline: {
    readonly ready: boolean;
    readonly signals: readonly {
      readonly signal: string;
      readonly label: string;
      readonly status: string;
      readonly samples: number;
    }[];
  };
  readonly rule: RuleView;
  readonly policy: {
    readonly label: string;
    readonly activeVersion: number;
    readonly activeLabel: string;
    readonly note: string;
  };
  readonly cases: readonly {
    readonly caseId: string;
    readonly title: string;
    readonly severity: string;
    readonly state: string;
    readonly facilityId: string;
  }[];
  readonly activeCaseId: string | null;
  readonly notifications: readonly SimDelivery[];
  readonly permissions: {
    readonly control: boolean;
    readonly editPolicy: boolean;
    readonly editAdapters: boolean;
    readonly reset: boolean;
  };
};

export type TimelineItem = {
  readonly at: string;
  readonly kind: string;
  readonly tone: "info" | "good" | "warn" | "bad";
  readonly title: string;
  readonly detail?: string;
  readonly actorId?: string;
  readonly caseId?: string;
};

export type SeriesPoint = { readonly t: number; readonly v: number; readonly trusted: boolean };
export type SimSeries = {
  readonly fromMs: number;
  readonly toMs: number;
  readonly series: Readonly<
    Record<
      "vibration" | "current" | "zoneTemperature" | "outdoorTemperature" | "backupRunning",
      {
        readonly label: string;
        readonly unit: string;
        readonly baseline: number | null;
        readonly points: readonly SeriesPoint[];
      }
    >
  >;
};

export type PolicyParam = {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  readonly operator: string;
  readonly role: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly integer: boolean;
};

export type PolicyView = {
  readonly label: string;
  readonly note: string;
  readonly parameters: readonly PolicyParam[];
  readonly active: {
    readonly version: number;
    readonly label: string;
    readonly values: Readonly<Record<string, number>>;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly reason: string;
    readonly builtin: boolean;
  };
  readonly versions: readonly {
    readonly version: number;
    readonly label: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly reason: string;
    readonly basedOn?: number;
    readonly builtin: boolean;
  }[];
  readonly defaults: Readonly<Record<string, number>>;
};

export type FieldTrace = {
  readonly signal: string;
  readonly sourcePath: string;
  readonly sourceValue: string | number | boolean | null;
  readonly sourceUnit?: string;
  readonly canonicalUnit: string;
  readonly conversion: string;
  readonly sourceAsset?: string;
  readonly assetId?: string;
  readonly canonicalValue?: number | boolean;
  readonly status: "ACCEPTED" | "REJECTED";
  readonly reason?: string;
  readonly detail?: string;
};

export type AdapterTraceDto = {
  readonly traceId: string;
  readonly deviceId?: string;
  readonly profileId: string;
  readonly version: number;
  readonly sourceType: string;
  readonly synthetic: boolean;
  readonly mode: "INGESTED" | "DRY_RUN";
  readonly receivedAt: string;
  readonly observedAt?: string;
  readonly payload: unknown;
  readonly fields: readonly FieldTrace[];
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicatesDropped: number;
  readonly outcome: "ACCEPTED" | "PARTIAL" | "REJECTED";
  readonly issues: readonly string[];
};

export type MappingRow = {
  readonly signal: string;
  readonly sourcePath: string;
  readonly valueType: string;
  readonly canonicalUnit: string;
  readonly units: readonly { readonly unit: string; readonly conversion: string }[];
  readonly enum?: Readonly<Record<string, boolean>>;
  readonly bounds?: { readonly min: number; readonly max: number };
  readonly asset: {
    readonly path?: string;
    readonly map?: Readonly<Record<string, string>>;
    readonly fixed?: string;
  };
};

export type AdapterProfile = {
  readonly profileId: string;
  readonly displayName: string;
  readonly vendorLabel: string;
  readonly description: string;
  readonly synthetic: boolean;
  readonly activeVersion: number;
  readonly versions: readonly {
    readonly version: number;
    readonly builtin: boolean;
    readonly publishedBy: string;
    readonly publishedAt: string;
    readonly reason: string;
  }[];
  readonly definition?: Record<string, unknown>;
  readonly mapping: readonly MappingRow[];
  readonly samplePayload: unknown;
  readonly boundDevices: readonly { readonly deviceId: string; readonly displayName: string }[];
  readonly recentTraces: readonly AdapterTraceDto[];
};

export type AdapterPreview = {
  readonly trace: AdapterTraceDto;
  readonly observations: readonly {
    readonly assetId: string;
    readonly signal: string;
    readonly value: number | boolean | null;
    readonly unit: string;
  }[];
};

export type AdapterCompare = {
  readonly instantAt: string;
  readonly flat: {
    readonly profileId: string;
    readonly payload: unknown;
    readonly trace: AdapterTraceDto | null;
  };
  readonly specialized: readonly {
    readonly profileId: string;
    readonly payload: unknown;
    readonly trace: AdapterTraceDto | null;
  }[];
  readonly equivalent: boolean;
  readonly tolerance?: { readonly absolute: number; readonly relative: number };
  readonly compared: readonly string[];
};

export type PulseResult = {
  readonly status: "OK" | "STOPPED" | "BUSY";
  readonly instants: number;
  readonly sent: number;
  readonly rejected: readonly {
    readonly deviceId: string;
    readonly status: number;
    readonly code: string;
  }[];
};

export type ApiProblem = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly string[];
};

export type SimCase = CaseDto;
