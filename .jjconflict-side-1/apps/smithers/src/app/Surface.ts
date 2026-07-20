/**
 * A canvas surface: the focused view that slides into the main canvas when you
 * open something for study. One at a time. Opened from nav, cards or slashes.
 */
export type GatewayRunSubview = "inspector" | "logs" | "diff" | "tickets" | "timeline";

export type Surface =
  | { kind: "inspector"; runId: string }
  | { kind: "diff"; runId: string; diffId: string }
  | { kind: "logs"; runId: string }
  | { kind: "timeline"; runId: string }
  | { kind: "tickets" }
  | { kind: "runs" }
  | { kind: "approvals" }
  | { kind: "agents" }
  | { kind: "memory" }
  | { kind: "files" }
  | { kind: "prompts" }
  | { kind: "scores" }
  | { kind: "crons" }
  | { kind: "vcs" }
  | { kind: "workflowEditor"; id: string }
  | { kind: "palette" }
  | {
      kind: "gatewayRun";
      runId: string;
      workflowKey: string;
      view?: GatewayRunSubview;
      diffId?: string;
    };
