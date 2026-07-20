import type { FleetRun } from "./FleetRun";

/**
 * Whether the supervisor should explicitly resume a quota-parked run now.
 *
 * This is a belt-and-suspenders backstop: the gateway daemon's `processDueTimers`
 * already auto-resumes `waiting-quota` runs at their reset, so this only fires
 * for a run whose window has already passed (e.g. if the sweep was down). It
 * mirrors the native rule exactly — a run with NO known reset (credit
 * exhaustion, not the 5-hour window) is left parked for a human, because
 * waking it would just loop against the same wall.
 */
export function shouldResumeQuota(run: FleetRun, nowMs: number): boolean {
  if (run.status !== "waiting-quota") return false;
  if (typeof run.quotaResetAtMs !== "number") return false;
  return run.quotaResetAtMs <= nowMs;
}
