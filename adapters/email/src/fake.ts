import type { EmailMessage, EmailTransport, TransportResult } from "./smtp";

/**
 * In-memory email provider for tests and local demos. Nothing leaves the process. It keeps an outbox
 * so a test can assert exactly what would have been sent, to whom, and how many times.
 */
export class FakeEmailTransport implements EmailTransport {
  readonly outbox: EmailMessage[] = [];
  readonly attempts: EmailMessage[] = [];
  private readonly script: TransportResult[] = [];
  private readonly rejected = new Set<string>();

  /** The next `send` calls answer with these results, in order (then the default applies). */
  failNext(...results: Extract<TransportResult, { ok: false }>[]): this {
    this.script.push(...results);
    return this;
  }

  /** A recipient the server permanently refuses. */
  rejectRecipient(address: string): this {
    this.rejected.add(address);
    return this;
  }

  async send(message: EmailMessage): Promise<TransportResult> {
    this.attempts.push(message);
    const scripted = this.script.shift();
    if (scripted !== undefined) return scripted;
    if (this.rejected.has(message.to)) {
      return {
        ok: false,
        code: "RECIPIENT_REJECTED",
        message: "SMTP server refused (550)",
        retryable: false,
      };
    }
    this.outbox.push(message);
    return { ok: true, response: "250 accepted (fake)" };
  }
}
