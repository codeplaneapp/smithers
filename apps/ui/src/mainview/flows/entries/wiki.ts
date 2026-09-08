/*
 * The `wiki` flows: the canonical names of the notes pane Will renamed from
 * World to Wiki (2026-09-07). The surface id, the card kind, the store events
 * and the CSS classes keep the `world` prefix so persisted sessions load
 * unchanged; only what a person reads or types says Wiki. entries/world.ts
 * registers the old names as hidden aliases over the same controller calls.
 */
import { Schema } from "effect"
import { WIKI_DISPLAY_NAME } from "../../state/AppState"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `wiki` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "wiki", label: WIKI_DISPLAY_NAME, summary: "What Smithers understands" }

/** The Wiki leads connect once something is connected. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "wiki", when: () => true, rank: (state) => (state.hasConnectors ? 1 : 2) }
]

/** Why `wiki.heading` is the human's alone: it scrolls their editor, which is focus. */
export const WIKI_HEADING_USER_ONLY_REASON = "scrolling the open note's editor to a heading is the human's viewport gesture; the agent reads a note with wiki.open"

/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export const wikiSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "wiki",
    summary: `See what Smithers understands (${WIKI_DISPLAY_NAME})`,
    input: NoPayload,
    handler: () => actions.showWorld()
  })
]

/** The `wiki.*` flows: notes and their confirms. */
export const wikiFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "wiki.new-note",
    summary: `Create a ${WIKI_DISPLAY_NAME} note`,
    input: NoPayload,
    handler: () => actions.createWorldDocument()
  }),
  flow({
    name: "wiki.select",
    summary: `Open a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.selectWorldDocument(documentId)
  }),
  /*
   * The vault kit's three flows (Librarian L5; 07-librarian.md §8 registers
   * wiki.open as the citation door). Each takes a note by path, file stem
   * or title, so a `[[wikilink]]` target and a citation ref both resolve.
   * The human's wiki.open opens the note in the pane; the agent's embeds it
   * as a card (THE EMBED LAW). wiki.backlinks is a read and embeds its card
   * for either actor. wiki.graph switches the pane to graph mode for the
   * human, and toggles back; for the agent it embeds the graph.
   */
  flow({
    name: "wiki.open",
    summary: `Open a ${WIKI_DISPLAY_NAME} note by path or title`,
    args: "<path>",
    input: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) => actions.openWorldDocument(path)
  }),
  flow({
    name: "wiki.backlinks",
    summary: "Notes that link to a note, and where it links out",
    args: "<path>",
    input: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) => actions.showWorldLinks(path)
  }),
  flow({
    name: "wiki.graph",
    summary: `The ${WIKI_DISPLAY_NAME} link graph, whole or around one note`,
    args: "[path]",
    input: Schema.Struct({ path: Schema.optional(Schema.String) }),
    handler: ({ path }) => actions.showWorldGraph(path)
  }),
  flow({
    /*
     * The outline's heading click: the open note's editor scrolls to the
     * heading's source line. Scrolling the human's own viewport is a focus
     * gesture, so the agent has no door; it reads a note with wiki.open.
     */
    name: "wiki.heading",
    summary: "Scroll the open note to a heading",
    hidden: true,
    userOnly: true,
    userOnlyReason: WIKI_HEADING_USER_ONLY_REASON,
    args: "<line>",
    input: Schema.Struct({ line: Schema.String }),
    handler: ({ line }) => actions.jumpToHeading(line)
  }),
  flow({
    name: "wiki.delete",
    summary: `Delete a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.removeWorldDocument(documentId)
  }),
  flow({
    /*
     * §10.6 / §28.4: deleting a note asks first, and the answer is an act of
     * its own, the same shape `admin.grant` uses. The agent may ASK (it can
     * offer to tidy a note) and may never answer for the human.
     */
    name: "wiki.delete.confirm",
    summary: "Delete the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "wiki.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  })
]
