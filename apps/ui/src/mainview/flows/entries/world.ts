/*
 * The `world` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { WORLD_DISPLAY_NAME } from "../../state/AppState"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The bare `world` surface switch, registered first with the other top-level surfaces. */
export const worldSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "world",
    summary: `See what Smithers understands (${WORLD_DISPLAY_NAME})`,
    input: NoPayload,
    handler: () => actions.showWorld()
  })
]

/** The `world.*` flows: notes and their confirms. */
export const worldFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "world.new-note",
    summary: "Create a world note",
    hidden: true,
    input: NoPayload,
    handler: () => actions.createWorldDocument()
  }),
  flow({
    name: "world.select",
    summary: "Open a world note",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.selectWorldDocument(documentId)
  }),
  flow({
    name: "world.delete",
    summary: "Delete a world note",
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.removeWorldDocument(documentId)
  }),
  flow({
    /*
     * §10.6 / §28.4: deleting a note asks first, and the answer is an act of
     * its own — the same shape `admin.grant` uses. The agent may ASK (it can
     * offer to tidy a note) and may never answer for the human.
     */
    name: "world.delete.confirm",
    summary: "Delete the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "world.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  })
]
