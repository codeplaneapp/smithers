// Owner-PID liveness probes for run-state classification, mirroring the
// engine's runtime-owner helpers WITHOUT importing the engine: engine already
// depends on db, so importing it back would form a dependency cycle (same
// reason time-travel keeps its own copy in isRunLikelyLive.js). Used by
// deriveRunState to refuse classifying a run as "orphaned" while its recorded
// driver process is demonstrably alive.

/**
 * Parse the owning process PID out of a `runtimeOwnerId` (`pid:1234` or a bare
 * number). Returns null when there is no parseable live-process PID.
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number | null}
 */
export function parseRuntimeOwnerPid(runtimeOwnerId) {
    if (!runtimeOwnerId)
        return null;
    const trimmed = runtimeOwnerId.trim();
    if (trimmed.length === 0)
        return null;
    const exact = trimmed.match(/^pid:(\d+)(?::.*)?$/i);
    const raw = exact ? exact[1] : /^\d+$/.test(trimmed) ? trimmed : null;
    if (raw === null)
        return null;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but we may not signal it — still alive.
        return /** @type {{ code?: string }} */ (error)?.code === "EPERM";
    }
}
