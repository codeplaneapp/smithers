import type { BenchmarkTask } from "./BenchmarkTask";
import type { ShardAssignment } from "./ShardAssignment";
import type { Subscription } from "./Subscription";
import { headroomScore } from "./headroomScore";

const MIN_CAPACITY = 0.01;

/**
 * Distribute benchmark tasks across subscriptions, weighted by how much
 * rate-limit headroom each sub has left. This is the fleet's "round-robin":
 * because each container IS one subscription, we do not rotate tokens — we
 * balance the shard each fixed container receives.
 *
 * Algorithm: greedy least-loaded. Each task goes to the subscription with the
 * smallest current `load / capacity`, where capacity is `headroomScore(usage)`
 * and load is the weight already assigned. With equal (or absent) usage this
 * reduces to even round-robin; when one sub is near its cap it receives close
 * to nothing until its window resets. A saturated sub still self-heals at
 * runtime via smithers' `waiting-quota` auto-resume.
 *
 * Deterministic: tasks are processed in a stable id order and ties break by
 * subscription index, so the same inputs always yield the same plan (safe for
 * replay and resume).
 */
export function planShards(
  tasks: readonly BenchmarkTask[],
  subscriptions: readonly Subscription[],
): ShardAssignment[] {
  if (subscriptions.length === 0) {
    throw new Error("planShards: need at least one subscription");
  }

  const shards: ShardAssignment[] = subscriptions.map((sub) => ({
    subscriptionId: sub.id,
    tasks: [],
    totalWeight: 0,
  }));
  const capacity = subscriptions.map((sub) =>
    Math.max(headroomScore(sub.usage), MIN_CAPACITY),
  );

  const ordered = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const task of ordered) {
    const weight = task.weight ?? 1;
    let best = 0;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < shards.length; i++) {
      const ratio = shards[i].totalWeight / capacity[i];
      if (ratio < bestRatio - 1e-9) {
        bestRatio = ratio;
        best = i;
      }
    }
    shards[best].tasks.push(task);
    shards[best].totalWeight += weight;
  }

  return shards;
}
