import { apiPost } from "./api";
import type { ApiResult } from "./api";

/**
 * Mutations: each is one POST to the application API as the signed-in development identity. The
 * API validates, authorizes and applies the lifecycle rules; the web app only forwards a person's
 * intent. There is deliberately no command for verification, recurrence or intervention: those
 * are decided by deterministic backend code, never by a click.
 */
const enc = encodeURIComponent;
type Done = Promise<ApiResult<unknown>>;

export const acknowledgeCase = (actorId: string, caseId: string, note?: string): Done =>
  apiPost(actorId, `/api/v1/cases/${enc(caseId)}/acknowledge`, note ? { note } : {});

export const assignAction = (
  actorId: string,
  caseId: string,
  actionLibraryId: string,
  assigneeId: string,
): Done =>
  apiPost(actorId, `/api/v1/cases/${enc(caseId)}/assignments`, { actionLibraryId, assigneeId });

export const acknowledgeAction = (actorId: string, caseId: string, actionId: string): Done =>
  apiPost(actorId, `/api/v1/cases/${enc(caseId)}/actions/${enc(actionId)}/acknowledge`, {});

export const reportAction = (
  actorId: string,
  caseId: string,
  input: { actionLibraryId: string; actionId: string; notes?: string },
): Done =>
  apiPost(actorId, `/api/v1/cases/${enc(caseId)}/actions`, {
    actionLibraryId: input.actionLibraryId,
    actionId: input.actionId,
    ...(input.notes ? { notes: input.notes } : {}),
  });

export const grantSharing = (
  actorId: string,
  input: {
    recipientOrganizationId: string;
    facilityId: string;
    scopes: readonly string[];
    expiresAt?: string;
  },
): Done =>
  apiPost(actorId, "/api/v1/sharing-agreements", {
    recipientOrganizationId: input.recipientOrganizationId,
    facilityIds: [input.facilityId],
    scopes: input.scopes,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });

export const revokeSharing = (actorId: string, agreementId: string, reason?: string): Done =>
  apiPost(
    actorId,
    `/api/v1/sharing-agreements/${enc(agreementId)}/revoke`,
    reason ? { reason } : {},
  );
