/**
 * Latency SLO configuration for Aspects.
 *
 * Runtime enforcement is not implemented yet; this is declarative metadata.
 */
export type LatencySloConfig = {
	/** Maximum total latency in milliseconds across all tasks. */
	maxMs: number;
	/** Optional per-task latency limit in milliseconds. */
	perTask?: number;
	/** Requested future behavior when the SLO is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn";
};
