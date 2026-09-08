/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §5, §6): the
 * indexes the browser holds, ranked by flows/SearchQuery.ts, answered two
 * ways. `palette` is the button door: synchronous rows for the overlay, read
 * from what the store already holds (§5: "the browser holds caches and
 * recents"), so every row is a fact a seam has already established. `search`
 * is the slash and agent door of every `search.*` flow: it reads the same
 * indexes, embeds a `search-results` card for a human and answers the items
 * as data for the model.
 *
 * NO INVENTION: this landing indexes files and flows; every other §1 mode
 * refuses in place until its `search.*` flow registers with its seam, and
 * nothing answers rows it did not read.
 */
import type { SearchAction, SearchItem } from "@smthrs/rpc/Cards"
import type { SearchArgs } from "../../flows/entries/search"
import { actionsFor, itemsValue, parseQuery, prefixRow, PREFIXES, rankItems } from "../../flows/SearchQuery"
import type { PaletteMode, ParsedQuery, PrefixRow, ResultGroup } from "../../flows/SearchQuery"
import type { CommandState, FlowEntry } from "../../flows/registry"
import { recommendedNames, unmetRequirements } from "../../flows/registry"
import type { Card, WorkingCopy } from "../AppState"
import type { SeamContext } from "./SeamContext"

/** The registry the seam reads: the flows it can act with and the state the scope rules read. */
export interface SearchRegistry {
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly state: () => CommandState
}

export interface SearchSeamDeps {
  readonly registry: () => SearchRegistry
  /** The boxes seam's silent refresh, for the `search.boxes` landing. */
  readonly refreshWorkspaces?: (repo?: string) => Promise<string | void>
  readonly now?: () => number
}

/** The overlay's answer for one draft. */
export interface PaletteAnswer {
  readonly parsed: ParsedQuery
  readonly groups: ReadonlyArray<ResultGroup>
  /** The mode's honest refusal when its index does not exist yet; shown in place, never as rows. */
  readonly refusal?: string
  /** `?`: every prefix, with whether this session may use it. */
  readonly help?: ReadonlyArray<PrefixRow & { readonly available: boolean }>
  /** The flow Enter runs with the query when no row is highlighted; null for a mode with none. */
  readonly flow: string | null
}

export interface SearchSeam {
  readonly palette: (text: string) => PaletteAnswer
  readonly search: (flow: string, mode: PaletteMode, args: SearchArgs) => Promise<string | void | { readonly value: string }>
}

/** Rows per group in the overlay: past this, typing more is the answer, as the slash menu's cap says. */
export const PALETTE_GROUP_CAP = 8
/** Items a flow answers when the call names no limit. */
export const SEARCH_DEFAULT_LIMIT = 50

export const NO_FOCUSED_FILE = "No file card is open to jump into; read one with files.read first."

/** The modes this landing indexes; the rest refuse by name until their flow registers. */
const SKELETON_MODES: ReadonlySet<PaletteMode> = new Set(["all", "path", "flows", "line", "help"])

/** The refusal a not-yet-registered mode shows in place. */
export const notRegisteredYet = (mode: PaletteMode): string =>
  `${prefixRow(mode).flow ?? `${prefixRow(mode).label} search`} is not registered yet; this landing searches files and flows.`

const joinPath = (directory: string, name: string): string => (directory === "" ? name : `${directory}/${name}`)

/** Signed out, a mode §4 hides answers nothing at all: no rows, no badge, and Enter still runs the flow, which defers through sign-in. */
const HIDDEN_SIGNED_OUT: ReadonlySet<PaletteMode> = new Set(["boxes", "secrets", "people"])

/** The flow behind a mode, when the registry has it. */
const flowOf = (mode: PaletteMode): string | null => (SKELETON_MODES.has(mode) ? prefixRow(mode).flow : null)

/** The flows a search names must be registered on this host; the rest of an item's actions come from the registry too. */
const withActions = (entries: ReadonlyArray<FlowEntry>, item: Omit<SearchItem, "actions">): SearchItem => ({
  ...item,
  actions: [...actionsFor(item, entries)]
})

export const createSearchSeam = (ctx: SeamContext, deps: SearchSeamDeps): SearchSeam => {
  const now = deps.now ?? (() => Date.now())
  const cards = (): ReadonlyArray<Card> => [...ctx.store.collections.cards.values()].sort((left, right) => left.ordinal - right.ordinal)

  /* ---- the indexes, each from a seam's own rows ---- */

  /** The slash tree as data: every listed flow this session may run (signed out, only what works signed out, as the slash menu offers). */
  const flowItems = (): ReadonlyArray<SearchItem> => {
    const { entries, state } = deps.registry()
    const snapshot = state()
    return entries()
      .filter((entry) => entry.metadata.hidden !== true)
      .filter((entry) => !snapshot.signedOut || unmetRequirements(entry.metadata, snapshot).length === 0)
      .map((entry) => ({
        kind: "flow" as const,
        ref: entry.binding.descriptor.name,
        title: entry.binding.descriptor.name,
        subtitle: entry.metadata.summary,
        actions: [{ flow: entry.binding.descriptor.name, label: entry.metadata.summary, role: "open" as const }]
      }))
  }

  /** Files the app has listed: the sidebar's loaded directories and the file and listing cards. Box files open in the box. */
  const fileItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    const add = (ref: string, subtitle: string, boxOpen?: SearchAction): void => {
      if (seen.has(ref)) return
      const item = withActions(entries, { kind: "file", ref, title: ref, subtitle })
      seen.set(ref, boxOpen === undefined ? item : { ...item, actions: [boxOpen, ...item.actions.filter((action) => action.role !== "open")] })
    }
    const copies = ctx.store.collections.workingCopies
    for (const row of ctx.store.collections.repoTree.values()) {
      if (row.state !== "loaded") continue
      const copy: WorkingCopy | undefined = copies.get(row.copyId)
      for (const entry of row.entries) {
        if (entry.kind !== "file") continue
        const path = joinPath(row.path, entry.name)
        if (copy?.kind === "workspace") {
          const workspaceId = copy.workspaceId ?? copy.id
          add(path, `${copy.label} (box)`, { flow: "workspace.file", args: `${path} ${workspaceId}`, label: "Read one file out of a cloud workspace", role: "open" })
        } else {
          add(path, copy?.label ?? row.copyId)
        }
      }
    }
    for (const card of cards()) {
      if (card.kind === "file") add(card.payload.address ?? card.payload.path, card.payload.repo)
      if (card.kind === "file-list") {
        for (const entry of card.payload.entries) {
          if (entry.kind !== "file") continue
          const path = joinPath(card.payload.path.replace(/^\/+/, ""), entry.name)
          add(card.payload.localRepoId === undefined && card.payload.address !== undefined ? `/${card.payload.repo}/${path}` : path, card.payload.repo)
        }
      }
    }
    return [...seen.values()]
  }

  /** `:120`: the line in the newest file card, as one item whose open flow re-reads the file at that line. */
  const lineItems = (parsed: ParsedQuery): ReadonlyArray<SearchItem> | string => {
    const file = [...cards()].reverse().find((card): card is Extract<Card, { kind: "file" }> => card.kind === "file")
    if (file === undefined || parsed.line === undefined) return NO_FOCUSED_FILE
    const at = `${parsed.line.line}${parsed.line.column === undefined ? "" : `:${parsed.line.column}`}`
    const path = file.payload.address ?? file.payload.path
    return [{
      kind: "file",
      ref: path,
      title: `${path}:${at}`,
      subtitle: file.payload.repo,
      actions: [{ flow: "files.read", args: `${path}:${at}`, label: "Read a file from a repository", role: "open" }]
    }]
  }

  /** The items of one mode, or the refusal that stands in for an index that does not exist. */
  const itemsOf = (mode: PaletteMode): ReadonlyArray<SearchItem> | string => {
    switch (mode) {
      case "all":
        return [...flowItems(), ...fileItems()]
      case "path":
        return fileItems()
      case "flows":
        return flowItems()
      case "line":
      case "help":
        return []
      default:
        return notRegisteredYet(mode)
    }
  }

  const rank = (items: ReadonlyArray<SearchItem>, query: string): ReadonlyArray<ResultGroup> => {
    const session = ctx.store.session()
    return rankItems(items, query, {
      recents: session.paletteRecents ?? [],
      now: now(),
      recommended: recommendedNames(deps.registry().state())
    })
  }

  /* ---- the button door: the overlay's rows ---- */

  const palette: SearchSeam["palette"] = (text) => {
    const parsed = parseQuery(text)
    const snapshot = deps.registry().state()
    const flow = flowOf(parsed.mode)
    if (parsed.mode === "help") {
      return {
        parsed,
        groups: [],
        flow,
        help: PREFIXES.map((row) => ({ ...row, available: !(row.signedIn && snapshot.signedOut) }))
      }
    }
    if (parsed.mode === "flows") return { parsed, groups: [], flow }
    if (snapshot.signedOut && HIDDEN_SIGNED_OUT.has(parsed.mode)) return { parsed, groups: [], flow }
    const items = parsed.mode === "line" ? lineItems(parsed) : itemsOf(parsed.mode)
    if (typeof items === "string") return { parsed, groups: [], flow, refusal: items }
    const groups = rank(items, parsed.query)
    /*
     * An empty bare query is the mock's opening: the pills and the recents,
     * nothing more (§2 rules 1 and 2). A prefixed empty query lists its mode.
     */
    const kept = parsed.mode === "all" && parsed.query === ""
      ? groups.filter((group) => group.label === "Recommended" || group.label === "Recent")
      : groups
    return { parsed, groups: kept.map((group) => ({ label: group.label, items: group.items.slice(0, PALETTE_GROUP_CAP) })), flow }
  }

  /* ---- the slash and agent door: the flows ---- */

  const search: SearchSeam["search"] = async (flow, mode, args) => {
    // The flow's query reads in its own mode's grammar, so `path:` is a qualifier for search.files too.
    const parsed = parseQuery(`${prefixRow(mode).prefix}${args.query}`)
    const query = parsed.query
    const base = itemsOf(mode)
    if (typeof base === "string") return base
    const kinds = args.kinds === undefined ? undefined : new Set(args.kinds)
    const pool = base.filter((item) => kinds === undefined || kinds.has(item.kind))
    const limit = args.limit ?? SEARCH_DEFAULT_LIMIT
    const items = rank(pool, query).flatMap((group) => group.items.map((row) => row.item)).slice(0, limit)
    const value = itemsValue(flow, args.query, items)
    if (ctx.actor() === "smithers") return { value }
    const id = `search-${flow}`
    const existing = ctx.store.collections.cards.get(id)
    const card: Card = {
      id,
      kind: "search-results",
      title: `Search · ${prefixRow(mode).prefix}${query === "" ? prefixRow(mode).searches : query}`,
      status: "active",
      createdAt: existing?.createdAt ?? now(),
      ordinal: ctx.nextOrdinal(),
      payload: { query: args.query, flow, ...(args.query === "" ? {} : { args: args.query }), items: [...items] }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return { value }
  }

  return { palette, search }
}

/** Whether a mode's flow needs a session (§4): the hidden-signed-out prefixes. */
export const signedInMode = (mode: PaletteMode): boolean => HIDDEN_SIGNED_OUT.has(mode)
