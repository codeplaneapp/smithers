import type { NodeStatus } from "../runs/Run";

/**
 * Map a gateway run/lifecycle state string onto the app's `NodeStatus` palette
 * (which drives every state color). The gateway speaks a richer set
 * (`waiting-approval`, `waiting-event`, `succeeded`, …); collapse it onto the
 * five tones the run UI knows. Unknown/empty falls back to `queued` (neutral).
 */
export function toNodeStatus(state: string | undefined): NodeStatus {
  switch (state) {
    case "running":
      return "running";
    case "succeeded":
    case "finished":
    case "completed":
    case "ok":
      return "ok";
    case "failed":
    case "errored":
    case "cancelled":
    case "canceled":
      return "failed";
    case "waiting-approval":
    case "waiting-event":
    case "waiting-timer":
    case "waiting":
    case "blocked":
      return "waiting";
    default:
      return "queued";
  }
}
