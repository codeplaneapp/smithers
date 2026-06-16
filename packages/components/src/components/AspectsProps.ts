import type React from "react";
import type { TokenBudgetConfig } from "../aspects/TokenBudgetConfig.ts";
import type { LatencySloConfig } from "../aspects/LatencySloConfig.ts";
import type { TrackingConfig } from "../aspects/TrackingConfig.ts";

export type AspectsProps = {
	/** Token budget — max total tokens, optional per-task limit, and exceeded behavior. */
	tokenBudget?: TokenBudgetConfig;
	/** Latency SLO — max total wall-clock latency and exceeded behavior. */
	latencySlo?: LatencySloConfig;
	/** Which metrics to track. Defaults to all enabled. */
	tracking?: TrackingConfig;
	/** Workflow content these aspects apply to. */
	children?: React.ReactNode;
};
