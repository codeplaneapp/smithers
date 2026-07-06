import type { BenchmarkTask } from "./BenchmarkTask";

/** The tasks assigned to one subscription's rollout container. */
export type ShardAssignment = {
  subscriptionId: string;
  tasks: BenchmarkTask[];
  /** Sum of task weights on this shard, for reporting balance. */
  totalWeight: number;
};
