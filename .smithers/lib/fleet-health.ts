// smithers-source: authored
//
// The pure, deterministic health filter for the fleet watchdog
// (monitor-smithers). Extracted from the workflow so it can be unit-tested in
// CI without an agent CLI: it decides which runs from a project's `ps` table
// are LIVE health (worth classifying / triaging) versus settled history.

/** The subset of a polled `ps` row the health filter reasons about. */
export type FleetHealthRow = {
	status: string;
	/** Minutes since the run STARTED, derived from the ps `started` age string. */
	ageMinutes: number;
	/**
	 * Minutes since the run FAILED, when the ps row exposes a finish time
	 * (`finishedAtMs`). Null/undefined when the installed CLI predates that
	 * field, in which case the filter falls back to `ageMinutes`.
	 */
	finishedAgeMinutes?: number | null;
};

/**
 * Keep only runs that represent live fleet health:
 *   - drop settled history (finished / cancelled): re-inspecting long-dead runs
 *     on every sweep is wasteful noise, not health;
 *   - keep a failure only while it is still fresh (< 60 min since it FAILED), so
 *     the medic escalates recent failures but not ancient ones. Freshness is
 *     judged from finish time (`finishedAgeMinutes`) when available, falling
 *     back to start age only when the ps row lacks it — a long agent run that
 *     died late still has a small time-since-failure and must not be dropped as
 *     "old" just because it started hours ago;
 *   - keep everything else (running, continued, orphaned, stale, unknown)
 *     regardless of age, so a wedged run is never filtered out of triage.
 */
export function filterFleetHealth<T extends FleetHealthRow>(runs: T[]): T[] {
	return runs.filter((run) => {
		if (run.status === "finished" || run.status === "cancelled") return false;
		if (run.status === "failed") return (run.finishedAgeMinutes ?? run.ageMinutes) < 60;
		return true;
	});
}
