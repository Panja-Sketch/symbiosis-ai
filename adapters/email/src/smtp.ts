import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

/**
 * Minimal SMTP submission client (S10, D-090): TLS (port 465) or STARTTLS (port 587), AUTH PLAIN,
 * one message per connection. No third-party dependency. Plain text is refused for any host other
 * than the loopback address (a test server). Credentials are only ever written to the TLS socket;
 * they are never logged and never appear in an error or a result.
 *
 * This is the DEMO transport (a dedicated Gmail account with an app password). It is not the
 * long-term enterprise email architecture: a transactional email service behind the same
 * `EmailTransport` port replaces it without touching alerts, follow-ups or the sender.
 */
export type EmailMessage = {
  readonly from: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly messageId: string;
  readonly date: Date;
  readonly extraHeaders?: Readonly<Record<string, string>>;
};

export type TransportResult =
  | { readonly ok: true; readonly response: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** False for a permanent refusal (bad recipient, rejected credentials). */
      readonly retryable: boolean;
    };

export interface EmailTransport {
  send(message: EmailMessage): Promise<TransportResult>;
}

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  /** `tls`: implicit TLS (465). `starttls`: upgrade after EHLO (587). `none`: loopback tests only. */
  readonly security: "tls" | "starttls" | "none";
  readonly timeoutMs?: number;
  readonly clientName?: string;
};

export type SmtpCredentials = { readonly username: string; readonly password: string };

const CRLF = "\r\n";
const MAX_MESSAGE_BYTES = 256 * 1024;

const headerSafe = (v: string): string => {
  if (/[\r\n\0]/.test(v)) throw new Error("illegal control character in a header value");
  return v;
};

/** RFC 2047 encoded-word for any non-ASCII header text. */
const encodeHeader = (v: string): string =>
  /^[\x20-\x7e]*$/.test(v)
    ? headerSafe(v)
    : `=?UTF-8?B?${Buffer.from(headerSafe(v), "utf8").toString("base64")}?=`;

const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join(CRLF);

export function buildMimeMessage(m: EmailMessage): string {
  const from =
    m.fromName !== undefined
      ? `${encodeHeader(m.fromName)} <${headerSafe(m.from)}>`
      : headerSafe(m.from);
  const headers = [
    `From: ${from}`,
    `To: ${headerSafe(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${headerSafe(m.messageId)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    ...Object.entries(m.extraHeaders ?? {}).map(([k, v]) => `${headerSafe(k)}: ${encodeHeader(v)}`),
  ];
  return (
    headers.join(CRLF) + CRLF + CRLF + wrap76(Buffer.from(m.text, "utf8").toString("base64")) + CRLF
  );
}

/** Dot-stuffing: a line that starts with "." must be doubled inside DATA. */
export const dotStuff = (data: string): string => data.replace(/(^|\r\n)\./g, "$1..");

type Reply = { readonly code: number; readonly text: string };

function classify(reply: Reply, during: string): TransportResult & { ok: false } {
  const { code } = reply;
  if (code === 535 || code === 534 || code === 530) {
    return {
      ok: false,
      code: "AUTH_FAILED",
      message: "SMTP authentication was rejected",
      retryable: false,
    };
  }
  if (code === 550 || code === 551 || code === 553 || code === 501 || code === 511) {
    return {
      ok: false,
      code: during === "rcpt" ? "RECIPIENT_REJECTED" : "MESSAGE_REJECTED",
      message: `SMTP server refused (${code})`,
      retryable: false,
    };
  }
  if (code === 552 || code === 554) {
    return {
      ok: false,
      code: "MESSAGE_REJECTED",
      message: `SMTP server refused (${code})`,
      retryable: false,
    };
  }
  if (code >= 400 && code < 500) {
    return {
      ok: false,
      code: "TRANSIENT",
      message: `SMTP temporary failure (${code})`,
      retryable: true,
    };
  }
  return {
    ok: false,
    code: "SMTP_ERROR",
    message: `unexpected SMTP reply (${code})`,
    retryable: code >= 500 ? false : true,
  };
}

class Session {
  private buffer = "";
  private waiting: ((r: Reply) => void) | undefined;
  private failure: ((e: Error) => void) | undefined;
  private queue: Reply[] = [];
  private lines: string[] = [];
  private error: Error | undefined;

  constructor(
    private socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("connection closed")));
    socket.setTimeout(this.timeoutMs, () => this.fail(new Error("timeout")));
  }

  swap(socket: TLSSocket) {
    this.socket = socket;
    this.buffer = "";
    this.attach(socket);
  }

  private fail(e: Error) {
    if (this.error !== undefined) return;
    this.error = e;
    this.failure?.(e);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at === -1) break;
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      this.lines.push(line);
      // The last line of a reply has a space after the code: "250 OK" (continuations use "250-").
      if (/^\d{3} ?/.test(line) && (line.length === 3 || line[3] === " ")) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join("\n") };
        this.lines = [];
        if (this.waiting !== undefined) {
          const w = this.waiting;
          this.waiting = undefined;
          w(reply);
        } else this.queue.push(reply);
      }
    }
  }

  reply(): Promise<Reply> {
    if (this.error !== undefined) return Promise.reject(this.error);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failure = reject;
    });
  }

  write(data: string) {
    this.socket.write(data);
  }

  async command(line: string): Promise<Reply> {
    this.write(line + CRLF);
    return this.reply();
  }

  get raw(): Socket | TLSSocket {
    return this.socket;
  }

  close() {
    this.socket.destroy();
  }
}

export class SmtpTransport implements EmailTransport {
  constructor(
    private readonly config: SmtpConfig,
    /** Resolved on every send so a rotated secret takes effect without a restart. */
    private readonly credentials: () => Promise<SmtpCredentials>,
  ) {
    if (config.security === "none" && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
      throw new Error("plain-text SMTP is only allowed to the loopback address");
    }
  }

  async send(message: EmailMessage): Promise<TransportResult> {
    const timeout = this.config.timeoutMs ?? 12_000;
    let session: Session | undefined;
    try {
      let creds: SmtpCredentials;
      try {
        creds = await this.credentials();
      } catch (error) {
        // No credentials configured is a permanent, loud failure (not a retry storm): the operator
        // has to add the secret. Any other failure to read them is transient.
        const notConfigured = error instanceof Error && error.name === "EmailNotConfigured";
        return {
          ok: false,
          code: notConfigured ? "EMAIL_NOT_CONFIGURED" : "CREDENTIALS_UNAVAILABLE",
          message: notConfigured
            ? "email credentials are not configured"
            : "email credentials could not be read",
          retryable: !notConfigured,
        };
      }
      let mime: string;
      try {
        mime = buildMimeMessage(message);
      } catch {
        return {
          ok: false,
          code: "INVALID_MESSAGE",
          message: "message could not be built",
          retryable: false,
        };
      }
      if (Buffer.byteLength(mime, "utf8") > MAX_MESSAGE_BYTES) {
        return {
          ok: false,
          code: "MESSAGE_TOO_LARGE",
          message: "message is too large",
          retryable: false,
        };
      }
      const name = this.config.clientName ?? "symbiosis.local";

      const socket: Socket | TLSSocket =
        this.config.security === "tls"
          ? tlsConnect({
              host: this.config.host,
              port: this.config.port,
              servername: this.config.host,
            })
          : createConnection({ host: this.config.host, port: this.config.port });
      session = new Session(socket, timeout);
      const greeting = await session.reply();
      if (greeting.code !== 220) return classify(greeting, "greeting");

      let ehlo = await session.command(`EHLO ${name}`);
      if (ehlo.code !== 250) return classify(ehlo, "ehlo");

      if (this.config.security === "starttls") {
        const st = await session.command("STARTTLS");
        if (st.code !== 220) return classify(st, "starttls");
        const upgraded = tlsConnect({
          socket: session.raw as Socket,
          servername: this.config.host,
        });
        session.swap(upgraded);
        ehlo = await session.command(`EHLO ${name}`);
        if (ehlo.code !== 250) return classify(ehlo, "ehlo");
      }

      if (this.config.security !== "none" || creds.username !== "") {
        const token = Buffer.from(`\0${creds.username}\0${creds.password}`, "utf8").toString(
          "base64",
        );
        const auth = await session.command(`AUTH PLAIN ${token}`);
        if (auth.code !== 235) return classify(auth, "auth");
      }
      const mail = await session.command(`MAIL FROM:<${message.from}>`);
      if (mail.code !== 250) return classify(mail, "mail");
      const rcpt = await session.command(`RCPT TO:<${message.to}>`);
      if (rcpt.code !== 250 && rcpt.code !== 251) return classify(rcpt, "rcpt");
      const data = await session.command("DATA");
      if (data.code !== 354) return classify(data, "data");
      session.write(dotStuff(mime) + "." + CRLF);
      const done = await session.reply();
      if (done.code !== 250) return classify(done, "data-end");
      try {
        await session.command("QUIT");
      } catch {
        // the message is already accepted
      }
      return { ok: true, response: "250 accepted" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      const timedOut = msg === "timeout";
      return {
        ok: false,
        code: timedOut ? "TIMEOUT" : "CONNECTION_FAILED",
        message: timedOut ? "SMTP server timed out" : "could not reach the SMTP server",
        retryable: true,
      };
    } finally {
      session?.close();
    }
  }
}
