// A waiting-timer run whose wake time has passed is only flagged `timer-overdue`
// after this grace window. A duration timer's deadline and the poller that fires
// it are not perfectly synchronized, so a few seconds past `firesAtMs` is normal;
// without a grace threshold every run would flicker unhealthy for a moment right
// at its wake time. Mirrors RUN_STATE_HEARTBEAT_STALE_MS (30s).
export const RUN_STATE_TIMER_OVERDUE_GRACE_MS = 30_000;
