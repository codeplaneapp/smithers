// @smithers-type-exports-begin
/** @typedef {import("./SupervisorProps.ts").SupervisorProps} SupervisorProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
import { Worktree } from "./Worktree.js";
import { useOptionalSmithersContext } from "./useOptionalSmithersContext.js";
/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 * @param {SupervisorProps} props
 */
export function Supervisor(props) {
  if (props.skipIf) return null;
  const prefix = props.id ?? "supervisor";
  const maxIterations = props.maxIterations ?? 3;
  const maxConcurrency = props.maxConcurrency ?? 5;
  const useWorktrees = props.useWorktrees ?? false;
  const workerNames = Object.keys(props.workers);
  const ctx = useOptionalSmithersContext();
  const latestReview = ctx?.latest?.(props.reviewOutput, `${prefix}-review`);
  const latestPlan = ctx?.latest?.(props.planOutput, `${prefix}-plan`);
  const allDone = latestReview?.allDone === true;
  // Build a worker Task element for each worker type.
  // At render time the runtime resolves which tasks are active based on
  // the plan output; here we declare one slot per worker type.
  const workerElements = workerNames.map((workerType) => {
    const workerId = `${prefix}-worker-${workerType}`;
    const workerTask = React.createElement(Task, {
      key: workerId,
      id: workerId,
      output: props.workerOutput,
      agent: props.workers[workerType],
      continueOnFail: true,
      // `deps` resolves the plan into the worker's prompt (`needs` alone is
      // cache-context only and injects nothing).
      needs: { plan: `${prefix}-plan` },
      deps: { plan: props.planOutput },
      label: `Worker: ${workerType}`,
      children: (d) =>
        `Execute tasks assigned to worker type "${workerType}". Refer to the plan for your specific instructions.\n\nPlan:\n${JSON.stringify(d.plan ?? "(no plan)")}`,
    });
    if (useWorktrees) {
      return React.createElement(
        Worktree,
        {
          key: workerId,
          path: `.worktrees/${workerId}`,
          branch: `worker/${workerId}`,
        },
        workerTask,
      );
    }
    return workerTask;
  });
  // Parallel worker execution
  const parallelWorkers = React.createElement(Parallel, { maxConcurrency }, ...workerElements);
  // Boss review Task — depends on the plan and every worker, and resolves all of
  // them into its prompt via `deps`. `depsOptional` omits workers that failed
  // (continueOnFail) rather than deferring the review forever.
  const reviewNeeds = { plan: `${prefix}-plan` };
  const reviewDeps = { plan: props.planOutput };
  for (const workerType of workerNames) {
    const workerId = `${prefix}-worker-${workerType}`;
    reviewNeeds[workerId] = workerId;
    reviewDeps[workerId] = props.workerOutput;
  }
  const reviewTask = React.createElement(Task, {
    id: `${prefix}-review`,
    output: props.reviewOutput,
    agent: props.boss,
    needs: reviewNeeds,
    deps: reviewDeps,
    depsOptional: true,
    label: "Supervisor review",
    children: (d) => {
      const workerResults = workerNames
        .map((workerType) => {
          const workerId = `${prefix}-worker-${workerType}`;
          return `### ${workerType}\n${workerId in d ? JSON.stringify(d[workerId]) : "(no result — this worker failed)"}`;
        })
        .join("\n\n");
      return `Review worker results. Set allDone to true if all tasks are satisfactory. List retriable task IDs in retriable[] if any need re-doing.\n\nPlan:\n${JSON.stringify(d.plan ?? "(no plan)")}\n\nWorker results:\n${workerResults}`;
    },
  });
  // Loop body: parallel workers then review
  const loopBody = React.createElement(Sequence, null, parallelWorkers, reviewTask);
  // Loop: repeat until boss says allDone (runtime resolves `until` reactively)
  const delegateLoop = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: allDone,
      maxIterations,
      onMaxReached: "return-last",
    },
    loopBody,
  );
  // Boss plan Task
  const planTask = React.createElement(Task, {
    id: `${prefix}-plan`,
    output: props.planOutput,
    agent: props.boss,
    label: "Supervisor plan",
    children: props.children,
  });
  // Final summary Task. The review lives inside the loop, so fold the plan and
  // the most recent review into the prompt via `latest` (the reader that
  // resolves the newest iteration's rows); Sequence ordering gates it after the
  // loop, and `needs` alone is cache-context only and injects nothing.
  const finalTask = React.createElement(Task, {
    id: `${prefix}-final`,
    output: props.finalOutput,
    agent: props.boss,
    needs: { review: `${prefix}-review`, plan: `${prefix}-plan` },
    label: "Supervisor summary",
    children: () =>
      `Summarize the overall results from all delegation cycles.\n\nPlan:\n${JSON.stringify(latestPlan ?? "(no plan)")}\n\nFinal review:\n${JSON.stringify(latestReview ?? "(no review)")}`,
  });
  return React.createElement(Sequence, null, planTask, delegateLoop, finalTask);
}
