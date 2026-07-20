import type { RunStatus } from "./RunStatus.ts";

export type RunResult = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly nextRunId?: string;
  /**
   * Number of tasks that ended `failed` yet did not fail the run — "masked"
   * child failures (a `continueOnFail` task, or an agent task that failed
   * transiently: rate limit, timeout, abort) the binary `finished` status cannot
   * express. Present (and `> 0`) only on a `finished` result. See
   * `docs/runtime/run-state.mdx`.
   */
  readonly failedChildren?: number;
  /**
   * Task state keys (`nodeId::iteration`) of the tasks counted by
   * {@link failedChildren}.
   */
  readonly failedChildKeys?: readonly string[];
};
