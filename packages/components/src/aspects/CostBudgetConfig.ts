/**
 * Cost budget configuration for Aspects.
 *
 * Runtime enforcement is not implemented yet; this is declarative metadata.
 */
export type CostBudgetConfig = {
	/** Maximum total cost in USD across all tasks within the Aspects scope. */
	maxUsd: number;
	/** Requested future behavior when the budget is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn" | "skip-remaining";
};
