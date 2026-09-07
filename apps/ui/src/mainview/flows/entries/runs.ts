/*
 * The `runs` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { line, text } from "../FlowForms"
import { flow } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `runs` flows registered as one aggregator block. */
export const runsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane runs — the run lifecycle beyond launch.
   *
   * The inbox (runs.list) answers from the workspace-runs projection; every
   * act is a control procedure over the gateway seam. What the wire does not
   * carry, the flow refuses in words: `by=` names a launcher the run summary
   * does not record, so it is a refusal, never a silently dropped filter.
   */
  flow({
    name: "runs.list",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(
          text(payload, "status"),
          text(payload, "flow"),
          text(payload, "by") === undefined ? undefined : `by=${text(payload, "by")}`,
          text(payload, "lineage") === undefined ? undefined : `lineage=${text(payload, "lineage")}`,
          text(payload, "repo")
        )
    },
    summary: "List the runs on your workspace",
    runtime: ["cloud"],
    args: "[status] [flow] [by=principal] [lineage=id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      status: Schema.optional(Schema.String),
      flow: Schema.optional(Schema.String),
      lineage: Schema.optional(Schema.String),
      by: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: (payload) => actions.listRuns(payload)
  }),
  flow({
    name: "runs.open",
    summary: "Open a run as a card that tracks it",
    runtime: ["cloud"],
    args: "<runId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ runId, repo }) => actions.openRun(runId, repo)
  }),
  flow({
    name: "runs.resume",
    confirm: "resume the run",
    summary: "Resume a parked run",
    runtime: ["cloud"],
    args: "<runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.resumeRun(runId)
  }),
  flow({
    /* A relaunch is real work on the user's workspace: the launch capability. */
    name: "runs.rerun",
    summary: "Run a run's flow again with the same input",
    runtime: ["cloud"],
    args: "<runId>",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.rerunRun(runId)
  }),
  flow({
    name: "runs.signal",
    confirm: "release the run's wait with a signal",
    summary: "Deliver a named signal to a waiting run",
    runtime: ["cloud"],
    args: "<runId> <name> [json]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      name: Schema.String,
      payload: Schema.optional(Schema.String)
    }),
    handler: ({ runId, name, payload }) => actions.signalRun(runId, name, payload)
  }),
  flow({
    name: "runs.steer",
    confirm: "steer the running agent",
    summary: "Send an operator message into a running run",
    runtime: ["cloud"],
    args: "<runId> <message>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, body: Schema.String }),
    handler: ({ runId, body }) => actions.steerRun(runId, body)
  }),
  flow({
    name: "runs.seat",
    confirm: "change the run's seat",
    summary: "Move a run to a different model seat",
    runtime: ["cloud"],
    args: "<runId> <seat>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, seat: Schema.String }),
    handler: ({ runId, seat }) => actions.steerRunSeat(runId, seat)
  }),
  flow({
    name: "runs.thinking",
    confirm: "change the run's thinking level",
    summary: "Change a run's thinking level",
    runtime: ["cloud"],
    args: "<runId> <level>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, thinking: Schema.String }),
    handler: ({ runId, thinking }) => actions.steerRunThinking(runId, thinking)
  }),
  flow({
    name: "runs.tools",
    confirm: "change the run's tools",
    summary: "Add tools to a run's active set",
    runtime: ["cloud"],
    args: "<runId> <names,comma-separated>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String, toolNames: Schema.String }),
    handler: ({ runId, toolNames }) => actions.steerRunTools(runId, toolNames)
  }),
  flow({
    name: "runs.logs",
    summary: "Show a run's transcript on its card (--follow keeps it live)",
    runtime: ["cloud"],
    args: "<runId> [--follow]",
    requires: ["signed-in"],
    input: Schema.Struct({
      runId: Schema.String,
      follow: Schema.optional(Schema.Boolean)
    }),
    handler: ({ runId, follow }) => actions.showRunLogs(runId, follow)
  }),
  flow({
    /* The run card's Steps tab: the card's own presentation act, so it stays hidden. */
    name: "runs.steps",
    summary: "Show a run's steps on its card",
    runtime: ["cloud"],
    hidden: true,
    args: "<runId>",
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.showRunSteps(runId)
  }),
  flow({
    /* The raw journal is a debug surface; the controller gates it on verbose. */
    name: "runs.events",
    summary: "Show a run's raw events on its card (verbose)",
    runtime: ["cloud"],
    args: "<runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ runId: Schema.String }),
    handler: ({ runId }) => actions.showRunEvents(runId)
  })
]
