export type BuildDelegationShardTasksOptions = {
  /** Benchmark id, used to namespace run ids. */
  benchmark: string;
  /** Path to the delegation workflow (default the bundled benchmark-delegation.tsx). */
  workflow?: string;
  /** Fallback per-instance wall-clock budget (minutes) when an instance sets none. */
  budgetMinutes?: number;
};
