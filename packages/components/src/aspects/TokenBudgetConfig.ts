/**
 * Token budget configuration for Aspects.
 *
 * Runtime enforcement is not implemented yet; this is declarative metadata.
 */
export type TokenBudgetConfig = {
	/** Maximum total tokens across all tasks within the Aspects scope. */
	max: number;
	/** Optional per-task token limit. */
	perTask?: number;
	/** Requested future behavior when the budget is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn" | "skip-remaining";
};
