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
   * Liveness probe for a local recorded owner PID. It defaults to
   * `process.kill(pid, 0)`. A stale run with a live local owner is reported
   * `"stale"`. A host-scoped remote owner is classified from its heartbeat
   * without calling this probe.
   */
  isOwnerPidAlive?: (pid: number) => boolean;
};
