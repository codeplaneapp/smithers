// The classifier lives in @smthrs/db so `@smthrs/time-travel` can share it
// without an engine/time-travel dependency cycle (same reason as
// `isRunLikelyLive.js`). Re-exported here as the engine-facing entry point.
export {
  classifyRunDriverLiveness,
  describeLiveDriverRefusal,
  isRunDriverAlive,
  readProcessStartMs,
  RUN_DRIVER_HEARTBEAT_STALE_MS,
  STEAL_OWNERSHIP_FLAG,
} from "@smthrs/db/runDriverLiveness";
