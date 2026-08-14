/**
 * Run states that mean "this run still owns its working copy".
 *
 * A run in any of these states either has a live engine editing files, or is
 * parked in a way it resumes from and expects its tree intact. `orphaned` is
 * deliberately absent: `deriveRunState` only reports it when the recorded
 * owner PID fails a liveness probe, so an orphaned run is a dead engine whose
 * tree nobody is coming back for. Terminal states are absent for the same
 * reason.
 */
const HOLDING_STATES = new Set([
  "running",
  "stale",
  "recovering",
  "paused",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
]);

/**
 * @param {string | null | undefined} state a `RunStateView.state`
 * @returns {boolean}
 */
export function isWorkingCopyHoldingRunState(state) {
  return typeof state === "string" && HOLDING_STATES.has(state);
}
