/**
 * Latency SLO configuration for Aspects.
 *
 * The engine enforces the scope-wide `maxMs` wall-clock SLO at task-dispatch
 * time, measured from the run's start.
 */
export type LatencySloConfig = {
	/** Maximum total wall-clock latency in milliseconds across all tasks. */
	maxMs: number;
	/** Optional per-task latency limit in milliseconds. Not enforced yet. */
	perTask?: number;
	/** Behavior when the SLO is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn";
};
