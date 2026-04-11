import React from "react";

export type TokenBudgetConfig = {
  max: number;
  perTask?: number;
  onExceeded?: "fail" | "warn" | "skip-remaining";
};

export type LatencySloConfig = {
  maxMs: number;
  perTask?: number;
  onExceeded?: "fail" | "warn";
};

export type CostBudgetConfig = {
  maxUsd: number;
  onExceeded?: "fail" | "warn" | "skip-remaining";
};

export type TrackingConfig = {
  tokens?: boolean;
  latency?: boolean;
  cost?: boolean;
};

export type AspectAccumulator = {
  totalTokens: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  taskCount: number;
};

export type AspectContextValue = {
  tokenBudget?: TokenBudgetConfig;
  latencySlo?: LatencySloConfig;
  costBudget?: CostBudgetConfig;
  tracking: TrackingConfig;
  accumulator: AspectAccumulator;
};

export const AspectContext = React.createContext<AspectContextValue | null>(null);
AspectContext.displayName = "AspectContext";

export function createAccumulator(): AspectAccumulator {
  return {
    totalTokens: 0,
    totalLatencyMs: 0,
    totalCostUsd: 0,
    taskCount: 0,
  };
}
