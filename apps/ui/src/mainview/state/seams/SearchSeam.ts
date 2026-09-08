/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §5, §6): the
 * indexes the browser holds, ranked by flows/SearchQuery.ts, answered two
 * ways. `palette` is the button door: synchronous rows for the overlay, read
 * from what the store already holds (§5: "the browser holds caches and
 * recents"), so every row is a fact a seam has already established. `search`
 * is the slash and agent door of every `search.*` flow: it reads the same
 * indexes, refreshes the ones that have a live read (boxes, secrets, history,
 * the factory projection), embeds a `search-results` card for a human and
 * answers the items as data for the model.
 *
 * NO INVENTION: a mode whose index does not exist yet (symbols, text, people,
 * the Librarian's ask) refuses with the exact reason, never with rows.
 */
import type { SearchAction, SearchItem } from "@smthrs/rpc/Cards"
import type { SearchArgs } from "../../flows/entries/search"
import { actionsFor, itemsValue, parseQuery, prefixRow, PREFIXES, rankItems } from "../../flows/SearchQuery"
import type { PaletteMode, ParsedQuery, PrefixRow, ResultGroup } from "../../flows/SearchQuery"
import type { CommandState, FlowEntry } from "../../flows/registry"
import { recommendedNames, unmetRequirements } from "../../flows/registry"
import type { Card, WorkingCopy } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readEnvironment } from "./EnvironmentSeam"
import { readHistory } from "./HistorySeam"
import type { SeamContext } from "./SeamContext"
import { readFactoryProjection } from "./TriggersSeam"

/** The registry the seam reads: the flows it can act with and the state the scope rules read. */
export interface SearchRegistry {
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly state: () => CommandState
}

export interface SearchSeamDeps {
  readonly registry: () => SearchRegistry
  /** The boxes seam's silent refresh, so `search.boxes` lists what plue holds now. */
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

export const NO_SYMBOL_INDEX = "No symbol index exists yet: the language server answers one position at a time (code.definition, code.hover), and nothing lists a file's symbols."
export const NO_TEXT_INDEX = "No text index exists yet: the mirror has no trigram index and no box grep is reachable from this app, so text: searches nothing."
export const NO_PEOPLE_SEAM = "No people seam exists yet: this app reads no user directory, so user: searches nothing."
export const ASK_PROPOSED = "ask: is proposed with the Librarian and not built; wiki: and history: search the same indexes."
export const NO_FOCUSED_FILE = "No file card is open to jump into; read one with files.read first."

const joinPath = (directory: string, name: string): string => (directory === "" ? name : `${directory}/${name}`)

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? ""

/** Signed out, a mode §4 hides answers nothing at all: no rows, no badge, and Enter still runs the flow, which defers through sign-in. */
const HIDDEN_SIGNED_OUT: ReadonlySet<PaletteMode> = new Set(["boxes", "secrets", "people"])

/** The flow behind a mode, when the registry has it. */
const flowOf = (mode: PaletteMode): string | null => prefixRow(mode).flow

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

  /** The Wiki pane's documents: the person's notes (generated pages exist on no catalog repository yet). */
  const wikiItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    return [...ctx.store.collections.worldDocuments.values()].map((document) =>
      withActions(entries, { kind: "note", ref: document.id, title: document.title, subtitle: document.path })
    )
  }

  /** The mythical history the history seam has read: epics, atomic commits, and the note sections. */
  const historyItems = (section?: string): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const out: Array<SearchItem> = []
    const note = (sha: string, owner: string, sections: Record<string, string | null> | null): void => {
      if (sections === null) return
      for (const [name, text] of Object.entries(sections)) {
        if (text === null || text.trim() === "" || (section !== undefined && section !== name)) continue
        // A note row's ref names its section beside the sha, so the epic and its notes stay distinct rows.
        out.push(withActions(entries, { kind: "history", ref: `${sha}#${name}`, title: `${name}: ${firstLine(text)}`, subtitle: `note · ${owner}` }))
      }
    }
    for (const card of cards()) {
      if (card.kind !== "history" || card.payload.mythical.state !== "present") continue
      for (const epic of card.payload.mythical.epics) {
        if (section === undefined) {
          out.push(withActions(entries, {
            kind: "history",
            ref: epic.sha,
            title: epic.title,
            subtitle: epic.merge ? `epic · ${epic.commits.length} commit${epic.commits.length === 1 ? "" : "s"}` : "commit"
          }))
        }
        note(epic.sha, epic.title, epic.note)
        for (const commit of epic.commits) {
          if (section === undefined) out.push(withActions(entries, { kind: "history", ref: commit.sha, title: commit.title, subtitle: `commit · ${epic.title}` }))
          note(commit.sha, commit.title, commit.note)
        }
      }
    }
    return out
  }

  /** Runs the runs controller has listed or opened. */
  const runItems = (status?: string): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    for (const card of cards()) {
      if (card.kind === "run-list") {
        for (const run of card.payload.runs) {
          if (status !== undefined && run.status !== status) continue
          seen.set(run.runId, withActions(entries, { kind: "run", ref: run.runId, title: run.runId, subtitle: `${run.flowId} · ${run.status}` }))
        }
      }
      if (card.kind === "run-trace" && (status === undefined || card.payload.phase === status)) {
        seen.set(card.payload.runId, withActions(entries, { kind: "run", ref: card.payload.runId, title: card.payload.runId, subtitle: `${card.payload.workflow} · ${card.payload.phase}` }))
      }
    }
    return [...seen.values()]
  }

  /** Changes the change seam has read (the changes collection). */
  const changeItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    return [...ctx.store.collections.changes.values()].map((row) =>
      withActions(entries, {
        kind: "change",
        ref: row.changeId,
        title: firstLine(row.description) || row.changeId,
        subtitle: `${row.repoId} · ${row.commitId === null ? "no commit" : row.commitId.slice(0, 8)}`
      })
    )
  }

  /** Issues the issues seam has listed or opened. */
  const issueItems = (is?: string): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    const add = (number: number, title: string, state: string, repo: string): void => {
      if (is !== undefined && state !== is) return
      seen.set(`${repo}#${number}`, withActions(entries, { kind: "issue", ref: String(number), title: `#${number} ${title}`, subtitle: `${state} · ${repo}` }))
    }
    for (const card of cards()) {
      if (card.kind === "issue-list") for (const issue of card.payload.issues) add(issue.number, issue.title, issue.state, card.payload.repo)
      if (card.kind === "issue") add(card.payload.number, card.payload.title, card.payload.state, card.payload.repo)
    }
    return [...seen.values()]
  }

  /** Targets the target graph seam has listed (the targets cards). */
  const targetItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    for (const card of cards()) {
      if (card.kind !== "targets") continue
      for (const target of card.payload.targets) {
        const ref = `${card.payload.repoId} ${target.label}`
        seen.set(ref, withActions(entries, { kind: "target", ref, title: target.label, subtitle: `${target.kinds.join(", ")} · ${card.payload.repoName}` }))
      }
    }
    return [...seen.values()]
  }

  /** Boxes the workspaces seam holds. */
  const boxItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    for (const row of ctx.store.collections.cloudWorkspaces.values()) {
      seen.set(row.id, withActions(entries, { kind: "box", ref: row.id, title: row.name, subtitle: `${row.repoId} · ${row.status}` }))
    }
    for (const copy of ctx.store.collections.workingCopies.values()) {
      if (copy.kind !== "workspace") continue
      const id = copy.workspaceId ?? copy.id
      if (seen.has(id)) continue
      seen.set(id, withActions(entries, { kind: "box", ref: id, title: copy.label, subtitle: `${copy.repoId}${copy.state === undefined ? "" : ` · ${copy.state}`}` }))
    }
    return [...seen.values()]
  }

  /** Secret NAMES the secrets seam has listed, with the hosts they bind to; no value exists on the wire. */
  const secretItems = (): ReadonlyArray<SearchItem> => {
    const entries = deps.registry().entries()
    const seen = new Map<string, SearchItem>()
    for (const card of cards()) {
      if (card.kind !== "secrets") continue
      for (const secret of card.payload.secrets) {
        seen.set(`${card.payload.repo}:${secret.name}`, withActions(entries, {
          kind: "secret-name",
          ref: secret.name,
          title: secret.name,
          subtitle: `${card.payload.repo}${secret.hosts.length === 0 ? "" : ` · ${secret.hosts.join(", ")}`}`
        }))
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
  const itemsOf = (mode: PaletteMode, parsed: Pick<ParsedQuery, "qualifiers">): ReadonlyArray<SearchItem> | string => {
    const qualifier = (key: string): string | undefined =>
      parsed.qualifiers.find((row) => row.key === key && !row.negated)?.value
    switch (mode) {
      case "all":
        return [...flowItems(), ...fileItems(), ...targetItems(), ...wikiItems(), ...historyItems(), ...runItems(), ...changeItems(), ...issueItems(), ...boxItems(), ...secretItems()]
      case "path":
        return fileItems()
      case "flows":
        return flowItems()
      case "targets":
        return targetItems()
      case "wiki":
        return wikiItems()
      case "history":
        return historyItems(qualifier("section"))
      case "runs":
        return runItems(qualifier("status"))
      case "changes": {
        const state = qualifier("state")
        return state === undefined ? changeItems() : "Changes on this wire carry no state to filter with; search without state:."
      }
      case "issues": {
        const label = qualifier("label")
        return label === undefined ? issueItems(qualifier("is")) : "Issue rows on this wire carry no labels to filter with; search without label:."
      }
      case "boxes":
        return boxItems()
      case "secrets":
        return secretItems()
      case "symbols":
        return NO_SYMBOL_INDEX
      case "text":
        return NO_TEXT_INDEX
      case "people":
        return NO_PEOPLE_SEAM
      case "ask":
        return ASK_PROPOSED
      case "line":
      case "help":
        return []
    }
  }

  /** The kinds §4 hides from a signed-out visitor, cut from a bare answer. */
  const scoped = (items: ReadonlyArray<SearchItem>, signedOut: boolean): ReadonlyArray<SearchItem> =>
    signedOut ? items.filter((item) => item.kind !== "box" && item.kind !== "secret-name" && item.kind !== "person") : items

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
    const items = parsed.mode === "line" ? lineItems(parsed) : itemsOf(parsed.mode, parsed)
    if (typeof items === "string") return { parsed, groups: [], flow, refusal: items }
    const groups = rank(scoped(items, snapshot.signedOut), parsed.query)
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

  /** The live reads a flow refreshes before it answers, where the mode has one. */
  const refresh = async (mode: PaletteMode, args: SearchArgs): Promise<string | undefined> => {
    if (mode === "boxes" && deps.refreshWorkspaces !== undefined) {
      const refused = await deps.refreshWorkspaces()
      return typeof refused === "string" ? refused : undefined
    }
    if (mode === "secrets" || mode === "history" || mode === "targets") {
      const target = resolveTargetRepo(ctx.store, args.repo)
      if ("error" in target) return mode === "targets" ? undefined : target.error
      const { repo } = target
      if (mode === "secrets") {
        const config = await readEnvironment(ctx, repo)
        if (typeof config === "string") return config
        ctx.dispatch({
          type: "card.upsert",
          actor: ctx.actor(),
          card: {
            id: `secrets-${repo}`,
            kind: "secrets",
            title: `Secrets · ${repo}`,
            status: "active",
            createdAt: ctx.store.collections.cards.get(`secrets-${repo}`)?.createdAt ?? now(),
            ordinal: ctx.store.collections.cards.get(`secrets-${repo}`)?.ordinal ?? ctx.nextOrdinal(),
            payload: {
              repo,
              scope: "repository",
              secrets: config.secrets.map((secret) => ({ name: secret.name, hosts: [...secret.hosts], matchHeaders: [...secret.matchHeaders], updatedAt: secret.updatedAt }))
            }
          }
        })
      }
      if (mode === "history" && ctx.store.collections.cards.get(`history-${repo}`) === undefined) {
        const payload = await readHistory(ctx, repo)
        if ("error" in payload) return payload.error
        ctx.dispatch({
          type: "card.upsert",
          actor: ctx.actor(),
          card: { id: `history-${repo}`, kind: "history", title: `Mythical history · ${repo}`, status: "active", createdAt: now(), ordinal: ctx.nextOrdinal(), payload }
        })
      }
    }
    return undefined
  }

  /** The factory projection's declared flows, as flow items that `flow.run` starts (targets: `//` reads the repository's own catalog). */
  const projectionFlows = async (args: SearchArgs): Promise<ReadonlyArray<SearchItem> | string> => {
    const target = resolveTargetRepo(ctx.store, args.repo)
    if ("error" in target) return []
    const read = await readFactoryProjection(ctx, target.repo)
    if ("error" in read) return `The factory of ${target.repo} couldn't be read: ${read.error}`
    if (read.absent) return []
    const entries = deps.registry().entries()
    const runnable = entries.some((entry) => entry.binding.descriptor.name === "flow.run")
    return (read.projection.flows ?? []).map((flow) => ({
      kind: "flow" as const,
      ref: flow.id,
      title: flow.id,
      subtitle: `${flow.summary ?? firstLine(flow.description)} · ${flow.path}`,
      actions: runnable ? [{ flow: "flow.run", args: flow.id, label: "Run a flow on your workspace", role: "open" as const }] : []
    }))
  }

  const search: SearchSeam["search"] = async (flow, mode, args) => {
    const refused = await refresh(mode, args)
    if (refused !== undefined) return refused
    // The flow's query reads in its own mode's grammar, so `section:tried` is a qualifier for search.history too.
    const parsed = parseQuery(`${prefixRow(mode).prefix}${args.query}`)
    const query = parsed.query
    const base = itemsOf(mode, parsed)
    if (typeof base === "string") return base
    const extra = mode === "targets" ? await projectionFlows(args) : []
    if (typeof extra === "string") return extra
    const snapshot = deps.registry().state()
    const kinds = args.kinds === undefined ? undefined : new Set(args.kinds)
    const pool = scoped([...base, ...extra], snapshot.signedOut).filter((item) => kinds === undefined || kinds.has(item.kind))
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
