import type { NotificationRequest, NotificationResult } from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { isValidEmail, maskEmail } from "@symbiosis/notifications";
import type { ContactDirectory, NotificationSender } from "@symbiosis/notifications";
import { SmtpTransport } from "./smtp";
import type { EmailMessage, EmailTransport, SmtpConfig, SmtpCredentials } from "./smtp";

/**
 * Email behind the `NotificationSender` port (S10, D-090). The recipient is an actor id; the address
 * comes from the organization-scoped contact directory, never from a request, an alert or code. This
 * class decides who may be emailed (address present and valid, person opted in to this kind); the
 * `EmailTransport` only moves bytes. Delivery results are explicit: SENT means the mail server
 * accepted the message, not that a person read it.
 */
export type EmailSenderOptions = {
  readonly clock: Clock;
  readonly contacts: ContactDirectory;
  readonly transport: EmailTransport;
  /** The sender mailbox, resolved per send (configuration or Secret Manager). */
  readonly from: () => string | Promise<string>;
  readonly fromName?: string;
  /** e.g. "Symbiosis" prepended to nothing but the From display name. */
};

export class EmailNotificationSender implements NotificationSender {
  readonly channel = "EMAIL" as const;

  constructor(private readonly options: EmailSenderOptions) {}

  async send(request: NotificationRequest): Promise<NotificationResult> {
    const base = {
      notificationId: request.notificationId,
      channel: this.channel,
      recipientRef: request.recipient.ref,
      requestedAt: request.requestedAt,
    };
    const fail = (code: string, message: string, retryable: boolean, hint?: string) =>
      ({
        ...base,
        status: "FAILED",
        completedAt: nowIso(this.options.clock),
        ...(hint !== undefined && { addressHint: hint }),
        failure: { code, message, retryable },
      }) satisfies NotificationResult;

    const contact = await this.options.contacts.get(request.organizationId, request.recipient.ref);
    if (contact === undefined || contact.email === undefined) {
      return fail(
        "NO_RECIPIENT_ADDRESS",
        "no email address is registered for the recipient",
        false,
      );
    }
    const email = contact.email;
    const hint = isValidEmail(email) ? maskEmail(email) : undefined;
    if (!isValidEmail(email)) {
      return fail("INVALID_RECIPIENT", "the registered email address is not valid", false);
    }
    if (!contact.enabled) {
      return fail(
        "RECIPIENT_OPTED_OUT",
        "the recipient turned email notifications off",
        false,
        hint,
      );
    }
    if (
      request.kind !== undefined &&
      request.kind !== "INITIAL" &&
      !contact.categories.includes(request.kind)
    ) {
      return fail(
        "RECIPIENT_OPTED_OUT",
        `the recipient does not want ${request.kind} emails`,
        false,
        hint,
      );
    }

    const message: EmailMessage = {
      from: await this.options.from(),
      ...(this.options.fromName !== undefined && { fromName: this.options.fromName }),
      to: email,
      subject: request.subject,
      text: request.body,
      messageId: `${request.notificationId}@symbiosis.local`,
      date: new Date(this.options.clock.nowMs()),
      extraHeaders: { "X-Symbiosis-Case": request.caseId },
    };
    let result;
    try {
      result = await this.options.transport.send(message);
    } catch {
      return fail("TRANSPORT_ERROR", "the email transport failed unexpectedly", true, hint);
    }
    if (!result.ok) return fail(result.code, result.message, result.retryable, hint);
    return {
      ...base,
      status: "SENT",
      completedAt: nowIso(this.options.clock),
      addressHint: hint ?? "",
    };
  }
}

/**
 * The demo email channel: the generic sender over the SMTP transport. Credentials are supplied as a
 * function (Secret Manager in the cloud); nothing is stored or printed here.
 */
export class SmtpEmailNotificationSender extends EmailNotificationSender {
  constructor(options: {
    readonly clock: Clock;
    readonly contacts: ContactDirectory;
    readonly smtp: SmtpConfig;
    readonly credentials: () => Promise<SmtpCredentials>;
    readonly from: () => string | Promise<string>;
    readonly fromName?: string;
  }) {
    super({
      clock: options.clock,
      contacts: options.contacts,
      transport: new SmtpTransport(options.smtp, options.credentials),
      from: options.from,
      ...(options.fromName !== undefined && { fromName: options.fromName }),
    });
  }
}
