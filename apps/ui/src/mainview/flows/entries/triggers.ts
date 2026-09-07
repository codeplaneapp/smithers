/*
 * The `triggers` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `triggers` flows registered as one aggregator block. */
export const triggersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* The dispatchers: what the repository's runs wait for. A read, so the agent lists it freely. */
    name: "triggers.list",
    summary: "List the triggers waiting on your workspace",
    runtime: ["cloud"],
    requires: ["signed-in"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.listTriggers(repo)
  })
]
