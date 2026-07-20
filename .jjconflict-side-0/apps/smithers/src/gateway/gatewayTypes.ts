import type { NodeStatus } from "../runs/Run";

/**
 * The gateway-facing domain types for apps/smithers. These mirror the gateway's
 * `listWorkflows` / `listRuns` / `getRun` payloads, narrowed to the fields the
 * app reads. Kept together because they describe one external surface (the
 * gateway), not unrelated kinds.
 */

/** A workflow registered on the gateway that ships its own custom UI. */
export type GatewayWorkflow = {
  key: string;
  readableName: string;
  description: string;
  /** The path the gateway serves the custom UI at, e.g. `/workflows/<key>`. */
  uiPath: string;
};

/** A run summary as returned by `listRuns` / `getRun`. */
export type GatewayRun = {
  runId: string;
  workflowKey: string;
  status: NodeStatus;
  createdAtMs: number;
};

/** The connection lifecycle of the gateway link. */
export type GatewayStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
