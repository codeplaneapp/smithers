/*
 * The `branches` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `branches` flows registered as one aggregator block. */
export const branchesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "branches.list",
    summary: "List a repository's branches (bookmarks)",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listBookmarks(repo)
  })
]
