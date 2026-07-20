/**
 * One benchmark instance, prepared for a delegation rollout: the agent-visible
 * problem statement and the checkout it edits. Prep (dataset row -> prompt +
 * isolated checkout) is benchmark-specific and happens upstream; this is the
 * neutral shape the fleet consumes.
 */
export type BenchmarkInstance = {
  /** Instance id within its benchmark (e.g. a SWE-Bench Pro instance_id). */
  id: string;
  /** The agent's brief: problem statement + requirements + interface. Never the tests or gold patch. */
  prompt: string;
  /** Working directory the agent edits (the V_old checkout). */
  cwd: string;
  /** Relative cost for shard balancing (default 1). */
  weight?: number;
  /** Optional per-instance wall-clock budget (minutes) passed to the delegation workflow. */
  budgetMinutes?: number;
};
