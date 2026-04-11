export const HUMAN_REQUEST_KINDS = ["ask", "confirm", "select", "json"] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];

export const HUMAN_REQUEST_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "expired",
] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];

export function buildHumanRequestId(
  runId: string,
  nodeId: string,
  iteration: number,
): string {
  return `human:${runId}:${nodeId}:${iteration}`;
}
