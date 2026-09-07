/*
 * The `feature` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `feature` flows registered as one aggregator block. */
export const featureFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Read-only: a chat turn that sketches the feature; no workspace, no branch, no pull request. */
    name: "feature.prototype",
    form: {
      fields: {
        request: { label: "What should it do?" },
        repo: { optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    summary: "Sketch a feature request against the repository, read-only",
    runtime: ["cloud"],
    args: "<what it should do> [owner/repo]",
    input: Schema.Struct({ request: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ request, repo }) => actions.prototypeFeature(request, repo)
  })
]
