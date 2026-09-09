import { Schema } from "effect"
import { flow } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

export const guideFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "onboarding.act",
    summary: "Guide the onboarding lesson, open or close the conversation, or update the optional profile",
    args: "<action> [value]",
    input: Schema.Struct({ action: Schema.String, value: Schema.optional(Schema.String) }),
    handler: ({ action, value }) => actions.guideAct(action, value),
  }),
]
