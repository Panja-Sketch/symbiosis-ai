/**
 * Structured logging for the cloud runtime (Cloud Logging reads one JSON object per stdout line;
 * `severity` and `message` are special). Fields named like credentials are replaced, and string
 * values that look like bearer tokens, JWTs or 256-bit hex keys are scrubbed, so a careless call
 * site cannot leak a secret into logs.
 */
export type LogFields = Readonly<Record<string, unknown>>;
export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface Logger {
  log(severity: Severity, message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SENSITIVE_NAME =
  /(token|authorization|password|passwd|secret|hmac|private|apikey|api_key|cookie|signature|credential)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const HEX_KEY = /\b[0-9a-fA-F]{64}\b/g;

export function scrubString(value: string): string {
  return value
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT, "[redacted-jwt]")
    .replace(HEX_KEY, "[redacted-hex]");
}

export function redactFields(fields: LogFields, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name === "key" || SENSITIVE_NAME.test(name)) {
      out[name] = "[redacted]";
    } else if (typeof value === "string") {
      out[name] = scrubString(value);
    } else if (value instanceof Error) {
      out[name] = scrubString(`${value.name}: ${value.message}`);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value) && depth < 3) {
      out[name] = redactFields(value as LogFields, depth + 1);
    } else {
      out[name] = value;
    }
  }
  return out;
}

export class JsonLogger implements Logger {
  constructor(
    private readonly base: LogFields = {},
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(severity: Severity, message: string, fields: LogFields = {}): void {
    const entry = {
      severity,
      message: scrubString(message),
      ...redactFields({ ...this.base, ...fields }),
    };
    this.write(JSON.stringify(entry));
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({ ...this.base, ...fields }, this.write);
  }
}

/** Collects entries for tests. */
export class MemoryLogger implements Logger {
  readonly entries: Record<string, unknown>[] = [];
  private readonly inner: JsonLogger;
  constructor(base: LogFields = {}) {
    this.inner = new JsonLogger(base, (line) => {
      this.entries.push(JSON.parse(line) as Record<string, unknown>);
    });
  }
  log(severity: Severity, message: string, fields?: LogFields): void {
    this.inner.log(severity, message, fields);
  }
  child(fields: LogFields): Logger {
    return this.inner.child(fields);
  }
}

export const nullLogger: Logger = {
  log() {},
  child() {
    return nullLogger;
  },
};
