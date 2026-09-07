/*
 * The `toast` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `toast` flows registered as one aggregator block. */
export const toastFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "toast.dismiss",
    summary: "Dismiss a toast notification",
    hidden: true,
    userOnly: true,
    userOnlyReason: "dismissing a toast is the human's gesture",
    args: "<toastId>",
    input: Schema.Struct({ toastId: Schema.String }),
    handler: ({ toastId }) => {
      actions.dismissToast(toastId)
    }
  })
]
