import type { BenchmarkInstance } from "./BenchmarkInstance";
import type { BenchmarkTask } from "./BenchmarkTask";
import { benchmarkRunId } from "./benchmarkRunId";

/**
 * Project prepared instances into `BenchmarkTask`s for `planShards`. The task id
 * matches the instance's run id so a shard assignment maps straight back to its
 * `ShardTask`.
 */
export function benchmarkTasksFromInstances(
  instances: readonly BenchmarkInstance[],
  benchmark: string,
): BenchmarkTask[] {
  return instances.map((instance) => ({
    id: benchmarkRunId(benchmark, instance.id),
    benchmark,
    weight: instance.weight,
  }));
}
