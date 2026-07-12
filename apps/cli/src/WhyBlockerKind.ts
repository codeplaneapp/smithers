export type WhyBlockerKind =
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer"
    | "stale-task-heartbeat"
    | "retry-backoff"
    | "retries-exhausted"
    | "stale-heartbeat"
    | "engine-busy"
    | "dependency-failed"
    | "approval-decided-resume-required";
