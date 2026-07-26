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
