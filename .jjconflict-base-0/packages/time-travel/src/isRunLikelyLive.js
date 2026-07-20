// Liveness signals for a run, mirroring the engine's runtime-owner + heartbeat
// staleness checks WITHOUT importing the engine: engine already depends on
// time-travel, so importing it back would form a dependency cycle. Used by
// jumpToFrame to refuse rewinding a run still being driven by a live process —
// the in-process rewind lock cannot coordinate across OS processes, so a
// concurrent rewind would race the engine's frame writes against the truncation.

/** Heartbeat-stale threshold; mirrors engine.js (`RUN_HEARTBEAT_STALE_MS`, 30s). */
const HEARTBEAT_STALE_MS = 30_000;

/**
 * Parse the owning process PID out of a `runtimeOwnerId` (`pid:1234` or a bare
 * number). Returns null when there is no parseable live-process PID.
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number | null}
 */
export function parseRuntimeOwnerPid(runtimeOwnerId) {
  if (!runtimeOwnerId) return null;
  const trimmed = runtimeOwnerId.trim();
  if (trimmed.length === 0) return null;
  const exact = trimmed.match(/^pid:(\d+)(?::.*)?$/i);
  const raw = exact ? exact[1] : /^\d+$/.test(trimmed) ? trimmed : null;
  if (raw === null) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * @param {number | null} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return /** @type {{ code?: string }} */ (error)?.code === "EPERM";
  }
}

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
