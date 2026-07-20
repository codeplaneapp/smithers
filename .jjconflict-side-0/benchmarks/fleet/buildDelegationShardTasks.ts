import type { BenchmarkInstance } from "./BenchmarkInstance";
import type { BuildDelegationShardTasksOptions } from "./BuildDelegationShardTasksOptions";
import type { ShardTask } from "./ShardTask";
import { benchmarkRunId } from "./benchmarkRunId";

const DEFAULT_WORKFLOW = "benchmarks/fleet/benchmark-delegation.tsx";

/**
 * Turn prepared benchmark instances into launchable `ShardTask`s that each run
 * the Claude-only headless delegation workflow. This is the delegation path the
 * long-horizon benchmarks use: one durable, resumable run per instance.
 */
export function buildDelegationShardTasks(
  instances: readonly BenchmarkInstance[],
  options: BuildDelegationShardTasksOptions,
): ShardTask[] {
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  return instances.map((instance) => {
    const budgetMinutes = instance.budgetMinutes ?? options.budgetMinutes;
    const input: Record<string, unknown> = { prompt: instance.prompt, cwd: instance.cwd };
    if (typeof budgetMinutes === "number") input.budgetMinutes = budgetMinutes;
    return {
      runId: benchmarkRunId(options.benchmark, instance.id),
      workflow,
      input,
    };
  });
}
