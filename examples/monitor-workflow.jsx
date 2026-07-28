// @ts-nocheck
/**
 * <Monitor> — a monitor workflow: a run that watches ANOTHER run and keeps it
 * healthy.
 *
 * Drop this file at `.smithers/monitor/<workflowId>.tsx` and Smithers launches
 * it automatically, as a sibling run, whenever `<workflowId>` starts. It is
 * linked to the watched run by `parent_run_id`, so `smithers ps`/`inspect` show
 * the pairing and `smithers cancel` tears the monitor down with the run. Select
 * one explicitly with `smithers up <workflow>.tsx --monitor <path>`, or opt out
 * with `--no-monitor`.
 *
 * Pattern: heartbeat <Timer> → classify health → <DecisionTable> routes the
 * condition to a handler → auto-heal or escalate.
 * Use cases: long unattended runs, overnight fleets, anything that must not
 * silently wedge at 3am.
 */
import { Monitor, monitorPrompt } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";

// The heartbeat's verdict. `condition` is the closed set <Monitor> routes on;
// everything else is the evidence that justified it.
const healthSchema = z.object({
  condition: z.enum(["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]),
  runStatus: z.string().describe("The watched run's status, as reported by `smithers status`/the Gateway."),
  targetNodeId: z.string().nullable().default(null).describe("The implicated node, when a single one is."),
  evidence: z.string().describe("What was actually read: node ids, attempt counts, timestamps, error text."),
  summary: z.string(),
});

// What a handler did about it. Handlers share one table so a single
// `smithers output` call shows the monitor's whole intervention history.
const actionSchema = z.object({
  action: z.string().describe("What the handler did, or `none` when it only observed."),
  changed: z.boolean().default(false).describe("Did the watched run's symptom change?"),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createExampleSmithers({
  health: healthSchema,
  action: actionSchema,
});

// The monitor reads run state through the public CLI surface, never the store.
// `bash` is enough: `smithers status`, `smithers inspect --format json`,
// `smithers events`, `smithers node`. A monitor that needs typed access should
// use `smithers-orchestrator/gateway-client` instead.
const watcher = new Agent({
  model: anthropic("claude-sonnet-5"),
  tools: { bash, read, grep },
  instructions: monitorPrompt(),
});

export default smithers((ctx) => (
  <Workflow name="monitor-workflow">
    <Monitor
      watchRunId={ctx.input.watchRunId}
      agent={watcher}
      healthOutput={outputs.health}
      actionOutput={outputs.action}
      intervalMs={60_000}
      maxChecks={120}
      // Only these two heal without a human: resuming a run and retrying a node
      // are idempotent and reversible. Everything else escalates.
      autoHeal={["stalled", "wedged-node"]}
      guidance="Runs here routinely sit on a single agent task for 20+ minutes. Streaming events mean healthy, however long it has been."
    />
  </Workflow>
));
