/*
 * The `keys` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `keys` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "keys", label: "Keys", summary: "Provider API keys" }

/** The `keys` flows registered as one aggregator block. */
export const keysFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "keys.list",
    summary: "List your provider API keys (masked)",
    runtime: ["keys.byok"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listKeys()
  }),
  flow({
    /* Removing a credential is destructive: agent invocations confirm first. */
    name: "keys.remove",
    summary: "Remove a provider API key",
    runtime: ["keys.byok"],
    confirm: "remove the provider API key",
    args: "<provider>",
    requires: ["signed-in"],
    input: Schema.Struct({ provider: Schema.String }),
    handler: ({ provider }) => actions.removeKey(provider)
  })
]
