export type ReasonUnhealthy =
  | { kind: "engine-heartbeat-stale"; lastHeartbeatAt: string }
  | { kind: "timer-overdue"; wakeAt: string; overdueMs: number }
  | { kind: "ui-heartbeat-stale"; lastSeenAt: string }
  | { kind: "db-lock" }
  | { kind: "sandbox-unreachable" }
  | { kind: "supervisor-backoff"; attempt: number; nextAt: string };
