// @smithers-type-exports-begin
/** @typedef {import("./ForkFanOutProps.ts").ForkFanOutProps} ForkFanOutProps */
/** @typedef {import("./ForkFanOutTask.ts").ForkFanOutTask} ForkFanOutTask */
/** @typedef {import("./ForkFanOutTask.ts").ForkFanOutTaskOptions} ForkFanOutTaskOptions */
// @smithers-type-exports-end

import React from "react";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";

/** Option keys forwarded from an entry (or `taskProps`) onto the generated Task. */
const TASK_OPTION_KEYS = ["continueOnFail", "timeoutMs", "heartbeatTimeoutMs", "retries"];

/**
 * Merge component-wide `taskProps` with per-entry overrides. Only allowlisted
 * option keys are forwarded, so callers can never replace generated-task
 * invariants (id, fork, agent, output) through `taskProps`. `undefined` entry
 * values never clobber a component-wide setting.
 * @param {ForkFanOutTaskOptions | undefined} taskProps
 * @param {ForkFanOutTask} entry
 */
function resolveTaskOptions(taskProps, entry) {
  const merged = {};
  for (const key of TASK_OPTION_KEYS) {
    if (taskProps?.[key] !== undefined) merged[key] = taskProps[key];
    if (entry[key] !== undefined) merged[key] = entry[key];
  }
  return merged;
}

/**
 * <ForkFanOut> — Fan out tasks that each fork the same source task's agent session.
 *
 * Every generated task waits for `fork` to complete (the fork edge is an
 * implicit dependency), then starts from a copy of the source's final
 * conversation in a fresh session and submits its own prompt. Built for
 * end-of-run chores that need the full context of the work just done (named
 * commits, linters, memory writes, logging) without depending on each other.
 *
 * Composes: Parallel[Task(fork=source) per entry].
 * @param {ForkFanOutProps} props
 */
export function ForkFanOut(props) {
  if (props.skipIf) return null;
  const { id, fork, tasks, agent, taskOutput, maxConcurrency, label, taskProps, children } = props;
  if (!fork) {
    throw new Error("ForkFanOut requires a fork source task id.");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("ForkFanOut tasks must include at least one task.");
  }
  const prefix = id ?? "fork-fan-out";
  // Entry ids are authored explicitly, so a duplicate is an authoring bug.
  // Fail fast here with a clear message rather than surfacing DUPLICATE_ID
  // from graph extraction.
  const seen = new Set();
  const elements = [];
  for (const entry of tasks) {
    if (entry.skipIf) continue;
    if (seen.has(entry.id)) {
      throw new Error(`ForkFanOut tasks contain a duplicate id: "${entry.id}".`);
    }
    seen.add(entry.id);
    const entryAgent = entry.agent ?? agent;
    if (!entryAgent) {
      throw new Error(
        `ForkFanOut task "${entry.id}" has no agent. Forking requires an agent task; ` +
          `set an agent on the entry or pass a component-level agent.`,
      );
    }
    const entryOutput = entry.output ?? taskOutput;
    if (!entryOutput) {
      throw new Error(
        `ForkFanOut task "${entry.id}" has no output. Tasks must declare an output; ` +
          `set taskOutput on the component or output on the entry.`,
      );
    }
    const taskId = `${prefix}-${entry.id}`;
    const prompt =
      children == null ? entry.prompt : React.createElement(React.Fragment, null, children, "\n\n", entry.prompt);
    elements.push(
      React.createElement(Task, {
        key: taskId,
        id: taskId,
        fork,
        agent: entryAgent,
        output: entryOutput,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...resolveTaskOptions(taskProps, entry),
        children: prompt,
      }),
    );
  }
  return React.createElement(
    Parallel,
    {
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      ...(label === undefined ? {} : { label }),
    },
    ...elements,
  );
}
