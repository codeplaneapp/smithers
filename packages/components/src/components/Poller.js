import React from "react";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { Task } from "./Task.js";
import { Loop } from "./Ralph.js";
import { Sequence } from "./Sequence.js";
import { Timer } from "./Timer.js";
/** @typedef {import("./PollerProps.ts").PollerProps} PollerProps */

/**
 * Compute the real wall-clock delay (ms) for one gap between poll attempts.
 *
 * `gap` is 0-indexed over the gaps, not the attempts: gap 0 is the pause
 * between attempt 1 and attempt 2. Nothing precedes the first attempt, so the
 * first poll always fires immediately. The returned delay is enforced by a
 * durable <Timer>; it is not a task timeout.
 * @param {number} gap
 * @param {number} baseMs
 * @param {"fixed" | "linear" | "exponential"} strategy
 * @returns {number}
 */
function computeDelayMs(gap, baseMs, strategy) {
  let raw;
  switch (strategy) {
    case "linear":
      raw = baseMs * (gap + 1);
      break;
    case "exponential":
      raw = baseMs * Math.pow(2, gap);
      break;
    case "fixed":
    default:
      raw = baseMs;
      break;
  }
  // A non-finite delay would be formatted as "Infinity ms"/"NaNms" (and any
  // value >= 1e21 as "1e+21ms"), none of which the engine's duration parser
  // accepts. Fail here, where the offending prop is still in scope.
  if (!Number.isFinite(raw)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `<Poller> computed a non-finite poll delay from intervalMs=${baseMs}, backoff="${strategy}".`,
    );
  }
  return Math.max(0, Math.round(raw));
}
/**
 * @param {PollerProps} props
 */
export function Poller(props) {
  if (props.skipIf) return null;
  const ctx = React.useContext(SmithersContext);
  const prefix = props.id ?? "poll";
  const maxAttempts = props.maxAttempts ?? 30;
  const backoff = props.backoff ?? "fixed";
  const baseInterval = props.intervalMs ?? 5000;
  const onTimeout = props.onTimeout ?? "fail";
  const iteration = ctx?.iterations?.[`${prefix}-loop`] ?? ctx?.iteration ?? 0;
  const checkRow = ctx?.outputMaybe(props.checkOutput, {
    nodeId: `${prefix}-check`,
    iteration,
  });
  const until = checkRow?.satisfied === true;
  // Determine if check is an agent or a compute function
  const isAgent = typeof props.check === "object" && props.check !== null && "generate" in props.check;
  // Build the check task
  const prompt =
    props.children ?? "Check whether the condition is satisfied. Return an object with a satisfied boolean.";
  const checkTask = isAgent
    ? React.createElement(Task, {
        id: `${prefix}-check`,
        output: props.checkOutput,
        timeoutMs: props.checkTimeoutMs,
        agent: props.check,
        children: prompt,
      })
    : React.createElement(Task, {
        id: `${prefix}-check`,
        output: props.checkOutput,
        timeoutMs: props.checkTimeoutMs,
        children: props.check,
      });
  // Pace the loop with a durable <Timer> ahead of the check, inside a
  // <Sequence> so the scheduler holds the check back until the timer fires.
  // The timer is skipped on the first iteration (poll immediately), so the
  // delay before attempt N is the (N-1)th gap.
  const delayMs = iteration === 0 ? 0 : computeDelayMs(iteration - 1, baseInterval, backoff);
  return React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until,
      maxIterations: maxAttempts,
      onMaxReached: onTimeout === "fail" ? "fail" : "return-last",
    },
    React.createElement(
      Sequence,
      null,
      React.createElement(Timer, {
        id: `${prefix}-delay`,
        duration: `${delayMs}ms`,
        skipIf: iteration === 0,
      }),
      checkTask,
    ),
  );
}
