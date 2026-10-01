export const ACTION_STATUSES = ["ASSIGNED", "ACKNOWLEDGED", "REPORTED_COMPLETE"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/**
 * A human-reported mitigation action. RECOMMEND_ONLY: never controls equipment, and a
 * reported completion is evidence of action, not of effectiveness (spec principle 2).
 * `reportedBy`/`reportedAt` are present if and only if status is REPORTED_COMPLETE.
 */
export type MitigationAction = {
  readonly actionId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly actionLibraryId: string;
  readonly assignedTo?: string;
  readonly reportedBy?: string;
  readonly reportedAt?: string;
  readonly notes?: string;
  readonly attachments?: readonly string[];
  readonly status: ActionStatus;
};
