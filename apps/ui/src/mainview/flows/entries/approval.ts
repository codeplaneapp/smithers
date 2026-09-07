/*
 * The `approval` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, CardTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `approval` flows registered as one aggregator block. */
export const approvalFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "approval.approve",
    summary: "Approve a pending approval card",
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "approved")
    }
  }),
  flow({
    name: "approval.deny",
    summary: "Deny a pending approval card",
    hidden: true,
    args: "<cardId>",
    capabilities: ["approve:self"],
    input: CardTarget,
    handler: ({ cardId }) => {
      actions.decideApproval(cardId, "denied")
    }
  })
]
