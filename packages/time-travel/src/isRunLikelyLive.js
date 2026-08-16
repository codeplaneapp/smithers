import { isPidAlive, parseRuntimeOwnerPid } from "@smthrs/db/runtime-owner";

// Liveness signals for a run, sharing the db package's host-aware runtime
// owner parser to avoid an engine/time-travel dependency cycle. Used by
// jumpToFrame to refuse rewinding a run still being driven by a live process —
// the in-process rewind lock cannot coordinate across OS processes, so a
// concurrent rewind would race the engine's frame writes against the truncation.

/** Heartbeat-stale threshold; mirrors engine.js (`RUN_HEARTBEAT_STALE_MS`, 30s). */
const HEARTBEAT_STALE_MS = 30_000;

export { parseRuntimeOwnerPid };

/**
 * True when `run` is most likely still being driven by a live process — its
 * owner PID is alive, or its heartbeat is fresh (within the stale window).
 * @param {{ runtimeOwnerId?: string | null; heartbeatAtMs?: number | null }} run
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRunLikelyLive(run, now = Date.now()) {
  if (isPidAlive(parseRuntimeOwnerPid(run.runtimeOwnerId))) return true;
  const heartbeatAtMs = run.heartbeatAtMs;
  return typeof heartbeatAtMs === "number" && now - heartbeatAtMs < HEARTBEAT_STALE_MS;
}
