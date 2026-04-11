import type { RunOptions } from "./RunOptions.ts";

export type TaskExecutorContext = {
  runId: string;
  options: RunOptions;
  signal?: AbortSignal;
};
