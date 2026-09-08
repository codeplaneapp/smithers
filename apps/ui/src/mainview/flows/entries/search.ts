/*
 * The `search` flows (Search and Command Palette Spec 2026-09-07 §6): one
 * flow per palette prefix, each with its three doors. The palette is the
 * button door and reads the same seam synchronously; the slash and agent
 * doors run these handlers, which answer the items as data and, for a human,
 * embed the `search-results` card. This landing registers the walking
 * skeleton: the bare search, files and flows; the other §6 ids follow with
 * their seams. Qualifiers (`path:`, `-path:`) ride inside the query, as §1
 * writes them.
 */
import { Schema } from "effect"
import type { PaletteMode } from "../SearchQuery"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `search` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "search",
  label: "Search",
  summary: "Find files and flows by name"
}

/** What every `search.*` flow takes: the query (qualifiers inside it), and the bounds a caller may set. */
export interface SearchArgs {
  readonly query: string
  readonly limit?: number
  /** `search.open` only: the kinds to keep, comma-separated in the slash form. */
  readonly kinds?: ReadonlyArray<string>
  readonly repo?: string
}

const Query = Schema.Struct({ query: Schema.String })
const OptionalQuery = Schema.Struct({ query: Schema.optional(Schema.String), kinds: Schema.optional(Schema.String) })

/** One `search.*` flow over one palette mode. */
const search = (actions: CommandActions, name: string, mode: PaletteMode, summary: string, args: string): FlowEntry =>
  flow({
    name,
    summary,
    args,
    input: Query,
    handler: ({ query }) => actions.search(name, mode, { query })
  })

/** The `search.*` flows registered as one aggregator block. */
export const searchFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "search.open",
    summary: "Search everything by name: files and flows",
    args: "[query] [--kinds file,flow]",
    input: OptionalQuery,
    handler: ({ query, kinds }) =>
      actions.search("search.open", "all", {
        query: query ?? "",
        ...(kinds === undefined ? {} : { kinds: kinds.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "") })
      })
  }),
  search(actions, "search.files", "path", "Find files by fuzzy path among the directories the app has listed", "<query> [path:… -path:…]"),
  search(actions, "search.flows", "flows", "The slash tree as data: every flow this session may run", "<query>")
]
