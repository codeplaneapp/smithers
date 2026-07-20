import type { ShardAssignment } from "./ShardAssignment";
import type { Subscription } from "./Subscription";
import { headroomScore } from "./headroomScore";

/** Render a shard plan as a human-readable table for `--dry-run`. */
export function formatShardPlan(
  shards: readonly ShardAssignment[],
  subscriptions: readonly Subscription[],
): string {
  const byId = new Map(subscriptions.map((s) => [s.id, s]));
  const total = shards.reduce((n, s) => n + s.tasks.length, 0);
  const lines: string[] = [];
  lines.push(`Fleet plan: ${total} tasks across ${shards.length} subscription(s)`);
  lines.push("");
  for (const shard of shards) {
    const sub = byId.get(shard.subscriptionId);
    const headroom = Math.round(headroomScore(sub?.usage) * 100);
    const byBench = new Map<string, number>();
    for (const t of shard.tasks) byBench.set(t.benchmark, (byBench.get(t.benchmark) ?? 0) + 1);
    const mix = [...byBench.entries()].map(([b, n]) => `${b}=${n}`).join(", ") || "(empty)";
    lines.push(
      `  ${shard.subscriptionId.padEnd(16)} ${String(shard.tasks.length).padStart(4)} tasks  ` +
        `weight ${String(shard.totalWeight).padStart(5)}  headroom ${String(headroom).padStart(3)}%  [${mix}]`,
    );
  }
  return lines.join("\n");
}
