import type { VerificationResult } from "@symbiosis/contracts";

/**
 * Presentation labels for "Did it work?". A result label is derived only from a persisted,
 * completed assessment; there is no label for "the user said it is fixed".
 */
export const VERIFICATION_PENDING_LABEL = "VERIFICATION PENDING" as const;

export const RESULT_LABELS: Readonly<Record<VerificationResult, string>> = {
  VERIFIED: "VERIFIED IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY VERIFIED",
  NOT_IMPROVING: "NOT IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

export const RESULT_DETAILS: Readonly<Record<VerificationResult, string>> = {
  VERIFIED:
    "Trusted post-action sensor readings met every required criterion of the verification policy.",
  PARTIALLY_VERIFIED:
    "Trusted readings improved materially but did not reach the policy target for every required criterion.",
  NOT_IMPROVING:
    "Trusted readings show the condition still does not meet the policy after the reported action.",
  INCONCLUSIVE:
    "The available evidence could not establish whether the condition improved (missing, stale or untrusted data).",
};
