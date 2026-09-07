/*
 * The `flow` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload, RepoTarget, CardTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The bare `flows` surface switch, registered first with the other top-level surfaces. */
export const flowsSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Ask 5 (will, 2026-09-02): the fourth surface — the workspace's flows,
     * beside chat, connect and world. User-only: the model lists flows with
     * flow.list, whose answer is an embedded card (THE EMBED LAW), so opening
     * a pane stays the human's own act.
     */
    name: "flows",
    summary: "See the flows on your workspace",
    userOnly: true,
    userOnlyReason: "a surface switch; the model lists flows with flow.list, which answers as an embedded card",
    input: NoPayload,
    handler: () => actions.showFlows()
  })
]

/** The `flow.*` flows: create, choose a repository, list, run, and the run controls. */
export const flowFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Wave 11 — "make me a workflow". The agent invokes this with the user's
     * description; the run renders as an embedded run card tracked live from
     * the relay event stream (THE EMBED LAW).
     *
     * Wave 12 §2: a trailing `owner/repo` names the target. Without one and
     * with more than one loaded repository, the chooser-among-loaded asks —
     * the target is a genuine user choice, not a guess.
     */
    name: "flow.create",
    summary: "Create a Smithers workflow from a description",
    runtime: ["cloud"],
    args: "<description> [owner/repo]",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({
      description: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ description }) => actions.createWorkflow(description)
  }),
  flow({
    /*
     * The answer to the which-repo question — one act, from the card.
     *
     * `userOnly` is load-bearing, not decoration. §2 exists because the target
     * is a GENUINE user choice and nothing may be provisioned on a guess; a
     * model that can execute this by name answers the human's question for
     * them and provisions on ITS guess. Hidden keeps it out of the catalog;
     * user-only keeps it un-executable even by a model that guesses the name.
     */
    name: "flow.repo.choose",
    summary: "Choose which loaded repository a workflow belongs to",
    runtime: ["cloud"],
    hidden: true,
    userOnly: true,
    userOnlyReason: "the answer to the which-repository card is the human's choice; a model must not provision on its guess",
    args: "<owner/repo>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.chooseWorkflowRepo(repo)
  }),
  flow({
    /*
     * Wave 12 §3 — the acts a run that has gone quiet offers, bound to the
     * card's buttons. Hidden from the slash menu and the catalog. Stopping a
     * run is consequential (the cancel is durable), so the model may ASK but
     * never perform it: `confirm` turns an agent invocation into a
     * confirmation message whose button runs the stop as the user.
     */
    name: "flow.run.stop",
    summary: "Stop a run",
    runtime: ["cloud"],
    hidden: true,
    confirm: "stop the run",
    args: "<cardId> [reason]",
    input: Schema.Struct({
      cardId: Schema.String,
      reason: Schema.optional(Schema.String)
    }),
    handler: ({ cardId, reason }) => actions.stopWatchingRun(cardId, reason)
  }),
  flow({
    /* A retry spends (agent-parity.md): the model may ask, the human confirms. */
    name: "flow.run.retry",
    summary: "Check a run again",
    runtime: ["cloud"],
    hidden: true,
    confirm: "check the run again",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.retryRunWatch(cardId)
  }),
  flow({
    name: "flow.list",
    summary: "List the workflows on your workspace",
    runtime: ["cloud"],
    requires: ["signed-in"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.listWorkspaceWorkflows(repo)
  }),
  flow({
    name: "flow.run",
    form: { fields: { name: { label: "Workflow" }, repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Run a workflow on your workspace",
    runtime: ["cloud"],
    args: "<name> [owner/repo]",
    requires: ["signed-in"],
    capabilities: ["outbound:launch"],
    input: Schema.Struct({
      name: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ name, repo }) => actions.runWorkflow(name, repo)
  })
]

/** `flow.run.stop-all`, registered after the `runs.*` block it acts across. */
export const flowRunStopAllFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Stopping every run is consequential: agent invocations confirm first. */
    name: "flow.run.stop-all",
    summary: "Stop every live run on your workspace",
    runtime: ["cloud"],
    hidden: true,
    confirm: "stop every run",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.stopAllRuns(repo)
  })
]
