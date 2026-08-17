export type RunResult = {
  readonly runId: string;
  readonly status:
    | "running"
    | "finished"
    | "failed"
    | "cancelled"
    | "continued"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer"
    | "waiting-quota";
  readonly output?: unknown;
  readonly error?: unknown;
  readonly nextRunId?: string;
  /**
   * Number of tasks that ended in a `failed` state yet did not fail the run —
   * "masked" child failures the run-level status cannot express. Present (and
   * `> 0`) only on a `finished` result that tolerated at least one failure
   * (a {@link https://smithers.sh/components/task `continueOnFail`} task, or an
   * agent task that failed transiently: rate limit, timeout, abort). A binary
   * `finished` status would otherwise read as a clean success. Persisted
   * finished runs with this signal derive as `succeeded-with-failures`, while
   * retaining the compatible terminal lifecycle status `finished`. See
   * `docs/runtime/run-state.mdx`.
   */
  readonly failedChildren?: number;
  /**
   * Task state keys (`nodeId::iteration`) of the tasks counted by
   * {@link failedChildren}. The iteration disambiguates the same `nodeId` failing
   * across loop/Ralph iterations.
   */
  readonly failedChildKeys?: readonly string[];
  /**
   * Loops (`<Loop>`/`<ReviewLoop>`) that exited via `onMaxReached: "return-last"`
   * with their `until` predicate still false. Present (and non-empty) only on a
   * `finished` result: the run completed, but these loops never converged, so a
   * green `done` verdict would be a lie (#1464 AWF-1).
   */
  readonly exhaustedLoops?: readonly {
    readonly id: string;
    readonly iteration: number;
    readonly maxIterations: number | null;
  }[];
};
