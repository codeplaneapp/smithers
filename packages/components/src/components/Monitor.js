// @smithers-type-exports-begin
/** @typedef {import("./MonitorCondition.ts").MonitorCondition} MonitorCondition */
/** @typedef {import("./MonitorProps.ts").MonitorProps} MonitorProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { Timer } from "./Timer.js";
import { Loop } from "./Ralph.js";
import { HumanTask } from "./HumanTask.js";
import { DecisionTable } from "./DecisionTable.js";
import { useOptionalSmithersContext } from "./useOptionalSmithersContext.js";
import {
  MONITOR_CONDITIONS,
  MONITOR_DEFAULT_AUTO_HEAL,
  MONITOR_TERMINAL_STATUSES,
  monitorPrompt,
} from "./monitorPrompt.js";

/** @param {string} value */
function shellArg(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * <Monitor> — a heartbeat health check that watches ONE other run and keeps it
 * healthy.
 *
 * Shape, per beat: `<Timer>` paces the loop, one agent `<Task>` samples the
 * watched run and classifies it into exactly one {@link MonitorCondition}, and
 * a `<DecisionTable>` routes that condition to its handler.
 *
 * `<DecisionTable>` is the router rather than `<ClassifyAndRoute>` because the
 * two solve different problems: `<ClassifyAndRoute>` classifies MANY items and
 * fans every category out in `<Parallel>`, while a monitor has exactly one
 * subject (the watched run) and needs first-match, one-handler-wins semantics —
 * which is precisely `<DecisionTable strategy="first-match">`. Routing here is
 * deterministic: the agent names a condition, the table picks the handler.
 *
 * The healing half is deliberately timid. Only `stalled` and `wedged-node` heal
 * without a human by default, because resuming a run and retrying a node are
 * the two repairs that are both idempotent and reversible. Everything else
 * escalates through a durable `<HumanTask>`. Put a condition in `autoHeal` to
 * grant broader authority; pass `handlers` to replace any element outright, or
 * map one to `null` to make it a no-op.
 *
 * The monitor never reads the store: its prompt binds it to the Gateway client
 * and the public CLI surface.
 *
 * @param {MonitorProps} props
 */
export function Monitor(props) {
  if (props.skipIf) return null;
  const ctx = useOptionalSmithersContext();
  const prefix = props.id ?? "monitor";
  const intervalMs = props.intervalMs ?? 60_000;
  const maxChecks = props.maxChecks ?? 120;
  const stallBeats = props.stallBeats ?? 3;
  const autoHeal = props.autoHeal ?? MONITOR_DEFAULT_AUTO_HEAL;
  const healAgent = props.healAgent ?? props.agent;
  const actionOutput = props.actionOutput ?? props.healthOutput;
  const watchRunId = props.watchRunId;
  const watchWorkflowPath =
    props.watchWorkflowPath ??
    (typeof ctx?.input?.watchWorkflowPath === "string" ? ctx.input.watchWorkflowPath : undefined);
  const checkId = `${prefix}-check`;
  // `latest` (not `outputMaybe`) is the correct reader for a loop's exit
  // condition and for routing: it resolves the newest iteration's row, so the
  // table routes on THIS beat's verdict rather than beat 0's.
  const health = ctx?.latest?.(props.healthOutput, checkId);
  const condition = typeof health?.condition === "string" ? health.condition : undefined;
  // A monitor must never outlive the run it watches. The loop's own exit is the
  // watched run reaching a terminal status; the CLI tears the monitor down as
  // well, so this is the graceful path, not the only one.
  const watchedRunFinished = MONITOR_TERMINAL_STATUSES.includes(
    /** @type {(typeof MONITOR_TERMINAL_STATUSES)[number]} */ (health?.runStatus),
  );
  const beat = ctx?.iterations?.[`${prefix}-loop`] ?? ctx?.iteration ?? 0;

  const promptNode =
    props.prompt ??
    props.children ??
    monitorPrompt({ watchRunId, intervalMs, stallBeats, autoHeal, guidance: props.guidance });

  const checkTask = React.createElement(Task, {
    id: checkId,
    output: props.healthOutput,
    agent: props.agent,
    // A sampling beat that fails must not kill the monitor: the next beat
    // re-samples, and a dead monitor is worse than a missed reading.
    continueOnFail: true,
    label: `Monitor beat ${beat + 1}: ${watchRunId}`,
    children: promptNode,
  });

  /**
   * Build one handler `<Task>`. Handlers are named per condition so an operator
   * reading `bunx smithers-orchestrator inspect` on the monitor run can see which repair fired.
   * @param {MonitorCondition} name
   * @param {string} instruction
   */
  const handlerTask = (name, instruction) =>
    React.createElement(Task, {
      id: `${prefix}-${name}`,
      output: actionOutput,
      agent: healAgent,
      continueOnFail: true,
      needs: { health: checkId },
      deps: { health: props.healthOutput },
      label: `Monitor: ${name}`,
      children: (/** @type {Record<string, unknown>} */ d) =>
        [
          `The heartbeat classified run ${watchRunId} as "${name}".`,
          "",
          `Health sample:\n${JSON.stringify(d.health ?? health ?? "(no sample)")}`,
          "",
          instruction,
          "",
          "Read run state only through `smithers-orchestrator/gateway-client` or the public CLI. Never open the store.",
          "Report exactly what you did and what changed. If the action did not change the symptom, say so plainly rather than trying something else.",
        ].join("\n"),
    });

  /**
   * Escalation is a durable human request on the MONITOR run, so it survives a
   * restart and shows up in `bunx smithers-orchestrator human list` / the Gateway.
   * @param {MonitorCondition} name
   * @param {string} ask
   */
  const escalate = (name, ask) =>
    React.createElement(HumanTask, {
      id: `${prefix}-escalate-${name}`,
      output: actionOutput,
      label: `Monitor escalation: ${name}`,
      prompt: [
        `Run ${watchRunId} looks "${name}" and the monitor is not allowed to fix it on its own.`,
        "",
        `Evidence: ${JSON.stringify(health?.evidence ?? health?.summary ?? "(none recorded)")}`,
        `Watched run status: ${health?.runStatus ?? "unknown"}`,
        health?.targetNodeId ? `Implicated node: ${health.targetNodeId}` : "",
        "",
        ask,
      ]
        .filter(Boolean)
        .join("\n"),
    });

  /** @type {Record<MonitorCondition, React.ReactElement | null>} */
  const defaults = {
    // Nothing to do. Rendering nothing IS the handler.
    healthy: null,
    stalled: autoHeal.includes("stalled")
      ? handlerTask(
          "stalled",
          watchWorkflowPath
            ? `Resume the run: \`bunx smithers-orchestrator up ${shellArg(watchWorkflowPath)} --resume --run-id ${shellArg(watchRunId)}\` (idempotent — it re-enters the same durable frame). Confirm with \`bunx smithers-orchestrator status ${shellArg(watchRunId)}\` that events resumed. Do nothing else.`
            : "Do not resume: watchWorkflowPath was not supplied. Report that the monitor cannot build a safe resume command.",
        )
      : escalate("stalled", "Should this run be resumed?"),
    "wedged-node": autoHeal.includes("wedged-node")
      ? handlerTask(
          "wedged-node",
          watchWorkflowPath && typeof health?.targetNodeId === "string" && health.targetNodeId
            ? `Retry the wedged node once: \`bunx smithers-orchestrator retry-task ${shellArg(watchWorkflowPath)} --run-id ${shellArg(watchRunId)} --node-id ${shellArg(health.targetNodeId)}\`. This resets that node's output and downstream dependents before creating fresh attempts. Report exactly what was reset. Do not retry a second time — a node that wedges again needs a human.`
            : "Do not retry: watchWorkflowPath or targetNodeId is missing from the health sample. Report the incomplete monitor evidence.",
        )
      : escalate("wedged-node", "Should this node be retried, or is the failure real?"),
    // Cancelling is destructive, so it ships behind an explicit opt-in: it only
    // becomes the handler when the author puts "runaway-loop" in `autoHeal`.
    "runaway-loop": autoHeal.includes("runaway-loop")
      ? handlerTask(
          "runaway-loop",
          `Cancel the runaway run: \`bunx smithers-orchestrator cancel ${shellArg(watchRunId)}\`. Record the loop id, its iteration count, and the token burn that justified cancelling BEFORE you cancel.`,
        )
      : escalate(
          "runaway-loop",
          "The loop is iterating without converging. Cancel the run, let it keep going, or change its exit condition?",
        ),
    // A parked run is healthy; surface it to the operator, never answer for them.
    "awaiting-human": handlerTask(
      "awaiting-human",
      "Do NOT resolve the approval or answer the human request. Report what is pending, who it is waiting on, and how long it has been parked, so the operator can act.",
    ),
    failing: handlerTask(
      "failing",
      "The run failed. Gather the failing node, its error, and the tail of the event log, and report them. Do not retry, rewind, or edit anything.",
    ),
    unknown: escalate(
      "unknown",
      "The monitor could not read consistent evidence and will not guess. What should it do next?",
    ),
  };

  const resolved = /** @type {Record<MonitorCondition, React.ReactElement | null>} */ ({
    ...defaults,
    ...props.handlers,
  });

  // First-match over the closed condition set. `healthy` (and any handler an
  // author mapped to `null`) contributes no rule, so it falls through to the
  // table's `default` — do nothing, keep watching.
  const rules = MONITOR_CONDITIONS.filter((name) => resolved[name] != null).map((name) => ({
    when: condition === name,
    then: /** @type {React.ReactElement} */ (resolved[name]),
    label: name,
  }));

  const router = React.createElement(DecisionTable, {
    id: `${prefix}-route`,
    rules,
    strategy: "first-match",
    default: undefined,
  });

  return React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: watchedRunFinished,
      maxIterations: maxChecks,
      // Running out of beats is the monitor's job ending, not a failure.
      onMaxReached: "return-last",
    },
    React.createElement(
      Sequence,
      null,
      React.createElement(Timer, {
        id: `${prefix}-beat`,
        duration: `${Math.max(0, Math.round(intervalMs))}ms`,
        // Sample immediately on the first beat; pace every beat after it.
        skipIf: beat === 0,
      }),
      checkTask,
      router,
    ),
  );
}
