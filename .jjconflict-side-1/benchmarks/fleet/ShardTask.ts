/**
 * One launchable unit for `worker.ts`: a detached smithers run. `workflow` is a
 * path (the bundled `benchmark-delegation.tsx` for the delegation path) and
 * `input` is its JSON input. The launcher writes a shard's `ShardTask[]` to each
 * container's `FLEET_SHARD_FILE`.
 */
export type ShardTask = {
  runId: string;
  workflow: string;
  input: Record<string, unknown>;
};
