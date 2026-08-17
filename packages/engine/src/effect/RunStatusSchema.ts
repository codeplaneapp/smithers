/**
 * Persisted lifecycle status. A tolerated child failure remains `finished`;
 * the derived RunState distinguishes it as `succeeded-with-failures`.
 */
export type RunStatusSchema =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "paused"
  | "finished"
  | "continued"
  | "failed"
  | "cancelled";
