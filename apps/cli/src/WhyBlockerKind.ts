export type WhyBlockerKind =
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "bound-stale"
  | "binding-missing"
  | "stale-task-heartbeat"
  | "retry-backoff"
  | "retries-exhausted"
  | "stale-heartbeat"
  | "engine-busy"
  | "dependency-failed"
  | "approval-decided-resume-required"
  | "side-effect-boundary-crossed";
