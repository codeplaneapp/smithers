export type RunStatusSchema =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "waiting-quota"
  | "paused"
  | "finished"
  | "continued"
  | "failed"
  | "cancelled";
