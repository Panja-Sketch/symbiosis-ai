/** Fixed feedback messages for completed actions (chosen by key; never free text from a URL). */
export const NOTICES: Readonly<Record<string, string>> = {
  acknowledged:
    "Risk acknowledged. You now own the next step: assign or report an approved action.",
  assigned:
    "Action assigned. It is a recommendation for a person to carry out; Symbiosis does not operate equipment.",
  "assignment-acknowledged": "Assignment acknowledged.",
  reported:
    "Action reported. This is not proof the risk improved: verification now waits for new, trusted sensor readings.",
  shared: "Sharing granted. The insurer can now see only the scopes you selected.",
  revoked:
    "Sharing revoked. The insurer's access ended immediately; the evidence package itself is unchanged.",
};
