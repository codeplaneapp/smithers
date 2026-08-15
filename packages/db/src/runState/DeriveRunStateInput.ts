import type { RunRow } from "../adapter/RunRow.ts";
import type { RunStateWarning } from "./RunStateWarning.ts";

export type DeriveRunStateInput = {
  run: RunRow;
  pendingApproval?: { nodeId: string; requestedAtMs: number } | null;
  pendingTimer?: { nodeId: string; firesAtMs: number } | null;
  pendingEvent?: { nodeId: string; correlationKey: string } | null;
  parkedEventBlock?: { kind: "approval-decided-resume-required"; nodeId: string } | { kind: "external-trigger" } | null;
  /** Heartbeats from active sandboxes associated with the run. */
  sandboxHeartbeats?: ReadonlyArray<number>;
  /** Durable operator warnings associated with the run. */
  warnings?: ReadonlyArray<RunStateWarning>;
  now?: number;
  staleThresholdMs?: number;
  /** Grace window (ms) past a timer's wake time before it is flagged overdue. */
  timerOverdueGraceMs?: number;
  /**
   * Liveness probe for the run's recorded owner PID (defaults to a local
   * `process.kill(pid, 0)` probe). A stale run whose owner PID is alive is
   * reported `"stale"` (busy engine, lagging heartbeat), never `"orphaned"`.
   * Callers classifying runs owned by another host should inject their own.
   */
  isOwnerPidAlive?: (pid: number) => boolean;
};
