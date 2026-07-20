import type { DevToolsNode } from "./DevToolsNode.ts";

type DevToolsBlockedReason =
  | { kind: "approval"; nodeId: string; requestedAt: string }
  | { kind: "event"; nodeId: string; correlationKey: string }
  | { kind: "timer"; nodeId: string; wakeAt: string }
  | { kind: "approval-decided-resume-required"; nodeId: string }
  | { kind: "external-trigger" }
  | {
      kind: "provider";
      nodeId: string;
      code: "rate-limit" | "auth" | "timeout";
    }
  | { kind: "tool"; nodeId: string; toolName: string; code: string }
  | { kind: "quota"; quotaBlockedCount: number; resetAtMs?: number };

type DevToolsUnhealthyReason =
  | { kind: "engine-heartbeat-stale"; lastHeartbeatAt: string }
  | { kind: "timer-overdue"; wakeAt: string; overdueMs: number }
  | { kind: "ui-heartbeat-stale"; lastSeenAt: string }
  | { kind: "db-lock" }
  | { kind: "sandbox-unreachable" }
  | { kind: "supervisor-backoff"; attempt: number; nextAt: string };

/**
 * Derived run state carried on DevTools snapshots. This protocol-owned wire
 * shape keeps consumers independent of the database package that computes it.
 */
export type DevToolsRunState = {
  runId: string;
  state:
    | "running"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer"
    | "waiting-quota"
    | "paused"
    | "recovering"
    | "stale"
    | "orphaned"
    | "failed"
    | "cancelled"
    | "succeeded"
    | "unknown";
  blocked?: DevToolsBlockedReason;
  unhealthy?: DevToolsUnhealthyReason;
  computedAt: string;
};

export type DevToolsSnapshot = {
  version: 1;
  runId: string;
  frameNo: number;
  seq: number;
  root: DevToolsNode;
  runState?: DevToolsRunState;
};
