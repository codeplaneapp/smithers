/** A shell command to run a benchmark's own harness for a shard of instances. */
export type HarnessCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};
