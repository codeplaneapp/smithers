/**
 * Token budget configuration for Aspects.
 *
 * The engine accumulates per-run token usage and enforces `max` at
 * task-dispatch time.
 */
export type TokenBudgetConfig = {
	/** Maximum total tokens across all tasks within the Aspects scope. */
	max: number;
	/** Optional per-task token limit. Not enforced yet. */
	perTask?: number;
	/** Behavior when the budget is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn" | "skip-remaining";
};
