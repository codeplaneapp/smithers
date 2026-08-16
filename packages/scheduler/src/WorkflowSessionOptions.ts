import type { TaskDescriptor } from "@smthrs/graph/TaskDescriptor";

/** A breached Aspects budget for a task that is about to be dispatched. */
export type AspectBudgetBreach = {
  readonly kind: "tokens" | "latency";
  readonly limit: number;
  readonly current: number;
  readonly onExceeded: "fail" | "warn" | "skip-remaining";
};

export type WorkflowSessionOptions = {
  readonly runId?: string;
  readonly nowMs?: () => number;
  readonly requireStableFinish?: boolean;
  readonly requireRerenderOnOutputChange?: boolean;
  readonly initialRalphState?: ReadonlyMap<
    string,
    {
      readonly iteration: number;
      readonly done: boolean;
    }
  >;
  readonly initialTimerStarts?: ReadonlyMap<string, number>;
  /** Retry-policy failure rungs restored from durable attempts. */
  readonly initialRetryCounts?: ReadonlyMap<string, number>;
  /** Absolute retry deadlines restored from durable attempts. */
  readonly initialRetryWait?: ReadonlyMap<string, number>;
  /** Last durable failures restored for tasks that may already be exhausted. */
  readonly initialTaskFailures?: ReadonlyMap<
    string,
    {
      readonly error: unknown;
      readonly recoveryCommand?: string;
    }
  >;
  /** Approval task keys restored from durable approved rows. */
  readonly initialApprovals?: ReadonlySet<string>;
  /**
   * Evaluate a runnable task's Aspects budgets against the run's accumulated
   * usage. Return the first breach, or `null`/`undefined` when within budget.
   * Only invoked for tasks that would otherwise execute.
   */
  readonly evaluateAspectBudget?: (descriptor: TaskDescriptor) => AspectBudgetBreach | null | undefined;
  /** Called when a task is skipped because its budget was exceeded (`skip-remaining`). */
  readonly onAspectBudgetSkip?: (descriptor: TaskDescriptor, breach: AspectBudgetBreach) => void;
  /** Called when a task continues despite an exceeded budget (`warn`). */
  readonly onAspectBudgetWarn?: (descriptor: TaskDescriptor, breach: AspectBudgetBreach) => void;
};
