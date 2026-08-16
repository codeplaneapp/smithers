export type TaskState =
  | "pending"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "waiting-quota"
  | "waiting-bound"
  | "bound-stale"
  | "in-progress"
  | "finished"
  | "failed"
  | "stalled"
  | "cancelled"
  | "skipped";
