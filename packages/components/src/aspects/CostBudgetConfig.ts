/**
 * Cost budget configuration for Aspects.
 *
 * The engine estimates per-run cost from reported token usage and enforces
 * `maxUsd` at task-dispatch time. Cost is only estimated for models the
 * built-in price table recognizes; unknown models contribute no cost.
 */
export type CostBudgetConfig = {
	/** Maximum total estimated cost in USD across all tasks within the Aspects scope. */
	maxUsd: number;
	/** Behavior when the budget is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn" | "skip-remaining";
};
