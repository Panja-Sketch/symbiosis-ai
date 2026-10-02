import type {
  NotificationChannel,
  NotificationRequest,
  NotificationResult,
} from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { NotificationSender } from "./sender";

/**
 * Test double: replays a scripted list of outcomes (the last one repeats) and records every
 * request. Use it to prove failure and retry behavior without any real channel.
 */
export class ScriptedNotificationSender implements NotificationSender {
  readonly channel: NotificationChannel = "CONSOLE_EMAIL";
  readonly requests: NotificationRequest[] = [];
  private calls = 0;

  constructor(
    private readonly clock: Clock,
    private readonly outcomes: readonly ("SENT" | "FAILED" | "FAILED_PERMANENT" | "THROW")[],
  ) {}

  async send(request: NotificationRequest): Promise<NotificationResult> {
    this.requests.push(request);
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)] ?? "SENT";
    this.calls += 1;
    if (outcome === "THROW") throw new Error("scripted sender exception");
    const base = {
      notificationId: request.notificationId,
      channel: this.channel,
      recipientRef: request.recipient.ref,
      requestedAt: request.requestedAt,
      completedAt: nowIso(this.clock),
    };
    if (outcome === "SENT") return { ...base, status: "SENT" };
    return {
      ...base,
      status: "FAILED",
      failure: {
        code: "SCRIPTED_FAILURE",
        message: "scripted",
        ...(outcome === "FAILED_PERMANENT" && { retryable: false }),
      },
    };
  }
}
