import type { RunOptions } from "./RunOptions.ts";
import type { RunResult } from "./RunResult.ts";

export type ContinueAsNewHandler = (
  transition: unknown,
  context: { runId: string; options: RunOptions },
) => Promise<RunResult> | RunResult;
