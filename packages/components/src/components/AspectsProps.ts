import type React from "react";
import type { TokenBudgetConfig } from "../aspects/TokenBudgetConfig.ts";
import type { LatencySloConfig } from "../aspects/LatencySloConfig.ts";
import type { CostBudgetConfig } from "../aspects/CostBudgetConfig.ts";
import type { TrackingConfig } from "../aspects/TrackingConfig.ts";

export type AspectsProps = {
	/** Token budget metadata. Runtime enforcement is not implemented yet. */
	tokenBudget?: TokenBudgetConfig;
	/** Latency SLO metadata. Runtime enforcement is not implemented yet. */
	latencySlo?: LatencySloConfig;
	/** Cost budget metadata. Runtime enforcement is not implemented yet. */
	costBudget?: CostBudgetConfig;
	/** Which metrics to track. Defaults to all enabled. */
	tracking?: TrackingConfig;
	/** Workflow content these aspects apply to. */
	children?: React.ReactNode;
};
