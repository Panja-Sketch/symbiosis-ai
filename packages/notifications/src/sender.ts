import type {
  NotificationChannel,
  NotificationRequest,
  NotificationResult,
} from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";

/**
 * Notification port (spec section 39: Email: ConsoleEmail | SmtpEmail). A future SmtpEmail
 * implements this interface unchanged. `send` must resolve with an explicit result; it must
 * not throw for ordinary delivery failure.
 */
export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(request: NotificationRequest): Promise<NotificationResult>;
}

/**
 * Local channel: writes the message to a sink (console by default). SENT means this
 * configured local channel accepted it; it is not external delivery proof and no real email is
 * sent. No SMTP and no secrets are involved.
 */
export class ConsoleEmail implements NotificationSender {
  readonly channel = "CONSOLE_EMAIL" as const;
  private readonly sink: (line: string) => void;

  constructor(
    private readonly clock: Clock,
    sink?: (line: string) => void,
  ) {
    this.sink = sink ?? ((line) => console.log(line));
  }

  async send(request: NotificationRequest): Promise<NotificationResult> {
    const base = {
      notificationId: request.notificationId,
      channel: this.channel,
      recipientRef: request.recipient.ref,
      requestedAt: request.requestedAt,
    };
    if (request.recipient.ref.trim().length === 0) {
      return {
        ...base,
        status: "FAILED",
        completedAt: nowIso(this.clock),
        failure: { code: "INVALID_RECIPIENT", message: "recipient reference is empty" },
      };
    }
    this.sink(
      [
        "----- ConsoleEmail (local; nothing was emailed) -----",
        `To: ${request.recipient.ref}${request.recipient.role ? ` (${request.recipient.role})` : ""}`,
        `Subject: ${request.subject}`,
        "",
        request.body,
        "-----------------------------------------------------",
      ].join("\n"),
    );
    return { ...base, status: "SENT", completedAt: nowIso(this.clock) };
  }
}
