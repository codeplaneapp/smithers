/*
 * The history seam: the mythical history of a repository (Factory design
 * session 2026-09-07 §3, mock 13), read through the Worker's public read seam
 * to the Smithers Cloud mirror. Probed 2026-09-07 on smithersai/smithers:
 *
 *   GET /api/repos/{o}/{r}                    200, carries default_bookmark
 *   GET /api/repos/{o}/{r}/git/refs           200, refs/heads/* only
 *   GET /api/repos/{o}/{r}/changes?limit=100  200, newest first, 100 per page,
 *                                             parent_change_ids in git parent order
 *   GET /api/repos/{o}/{r}/contents/{p}?ref=  200 for a bookmark name or a commit sha
 *   GET /api/repos/{o}/{r}/git/commits/{sha}  501 "not implemented"
 *   GET /api/repos/{o}/{r}/git/trees/{sha}    501 "not implemented"
 *   GET /api/repos/{o}/{r}/git/blobs/{sha}    no such route on the mirror
 *
 * So the commit graph comes from the change feed (the walk the activity route
 * already does), notes come from /contents against the notes commit, and the
 * tree-equality badge is a typed "unsupported" until /git/commits answers.
 * Nothing here invents a row: a count the feed could not finish is null, a
 * note the mirror does not hold is null, and the honest empty state is one
 * sentence with one door.
 */
import type { HistoryEpic, HistoryNote } from "@smthrs/rpc/Cards"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"

export const MYTHICAL_REF = "refs/heads/mythical"
export const MYTHICAL_NOTES_REF = "refs/notes/mythical"

/** The mirror's page ceiling for the change feed. */
const PAGE_SIZE = 100
/** Bounds the change-feed walk, the same bound the activity route uses; a walk that outruns it answers null, never a partial count. */
export const MAX_CHANGE_PAGES = 20
/** Bounds the per-commit note reads on one show. */
const NOTE_READ_CAP = 40
/** Bounds one epic's second-parent chain, so a malformed history cannot spin. */
const MAX_EPIC_COMMITS = 500

export type HistoryPayload = Extract<Card, { kind: "history" }>["payload"]
type Mythical = HistoryPayload["mythical"]

export interface HistorySeam {
  readonly showHistory: (repo?: string) => Promise<string | void>
  /** The write doors (bootstrap, amend, fold): registered, signed-in, and refusing until the retell flow exists. */
  readonly retellHistory: (door: "bootstrap" | "amend" | "fold", repo?: string) => Promise<string | void>
}

/**
 * The empty state's one sentence. The count is the default bookmark's
 * commits from the change feed; when the feed could not be walked to the
 * root the sentence says so instead of guessing.
 */
export const emptyHistorySentence = (bookmark: string | null, mainCommits: number | null): string => {
  const name = bookmark ?? "the default bookmark"
  if (mainCommits === null) return `No mythical history yet. The commit count of ${name} is not available.`
  return `No mythical history yet. ${name} has ${mainCommits} commit${mainCommits === 1 ? "" : "s"}.`
}

/** The badge line: the invariant tree(mythical) == tree(main), or why it cannot be checked. */
export const treeEqualLabel = (
  mythical: Extract<Mythical, { state: "present" }>,
  bookmark: string | null
): string => {
  const name = bookmark ?? "the default bookmark"
  const at = mythical.mainHead === null ? "" : ` @ ${mythical.mainHead.slice(0, 7)}`
  if (mythical.treeEqual === "equal") return `tree-equal to ${name}${at}`
  if (mythical.treeEqual === "different") return `tree differs from ${name}${at}`
  return "tree-equal: not available (the mirror does not serve git commits yet)"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/* ---- the change graph ---- */

interface ChangeRow {
  readonly changeId: string
  readonly commitId: string
  readonly title: string
  /** Parent change ids in git parent order (verified against git rev-list --parents on the live mirror). */
  readonly parents: ReadonlyArray<string>
}

const parseChange = (value: unknown): ChangeRow | null => {
  if (!isRecord(value) || typeof value.change_id !== "string" || typeof value.commit_id !== "string") return null
  const description = typeof value.description === "string" ? value.description : ""
  const parents = Array.isArray(value.parent_change_ids)
    ? value.parent_change_ids.filter((id): id is string => typeof id === "string")
    : []
  return { changeId: value.change_id, commitId: value.commit_id, title: description.split("\n")[0] ?? "", parents }
}

export class ChangeGraph {
  readonly byChange = new Map<string, ChangeRow>()
  readonly byCommit = new Map<string, ChangeRow>()

  add(row: ChangeRow): void {
    this.byChange.set(row.changeId, row)
    this.byCommit.set(row.commitId, row)
  }

  /**
   * Every ancestor of a commit, or null while one is still unresolved (its
   * change id has not been read off the feed yet).
   */
  ancestors(commitId: string): ReadonlyArray<ChangeRow> | null {
    const start = this.byCommit.get(commitId)
    if (start === undefined) return null
    const seen = new Set<string>()
    const out: Array<ChangeRow> = []
    const queue: Array<ChangeRow> = [start]
    while (queue.length > 0) {
      const row = queue.pop()!
      if (seen.has(row.changeId)) continue
      seen.add(row.changeId)
      out.push(row)
      for (const parent of row.parents) {
        const next = this.byChange.get(parent)
        if (next === undefined) return null
        queue.push(next)
      }
    }
    return out
  }

  /** The first-parent line from a commit to the root, or null while a link is unresolved. */
  firstParentLine(commitId: string): ReadonlyArray<ChangeRow> | null {
    const out: Array<ChangeRow> = []
    let row = this.byCommit.get(commitId)
    const seen = new Set<string>()
    while (row !== undefined) {
      if (seen.has(row.changeId)) return out
      seen.add(row.changeId)
      out.push(row)
      const first = row.parents[0]
      if (first === undefined) return out
      row = this.byChange.get(first)
      if (row === undefined) return null
    }
    return null
  }

  /**
   * An epic's atomic commits: the second parent's first-parent chain down to
   * (not including) a commit on the epic's own first-parent line. Null while
   * a link is unresolved.
   */
  secondParentChain(merge: ChangeRow, line: ReadonlySet<string>): ReadonlyArray<ChangeRow> | null {
    const second = merge.parents[1]
    if (second === undefined) return []
    const out: Array<ChangeRow> = []
    let row = this.byChange.get(second)
    while (out.length < MAX_EPIC_COMMITS) {
      if (row === undefined) return null
      if (line.has(row.changeId)) return out
      out.push(row)
      const first = row.parents[0]
      if (first === undefined) return out
      row = this.byChange.get(first)
    }
    return out
  }
}

/* ---- the mirror reads ---- */

const repoBase = (ctx: SeamContext, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** One mirror document as JSON, or null with the status when the mirror could not answer it. */
const readJson = async (ctx: SeamContext, url: string): Promise<{ status: number; body: unknown }> => {
  try {
    const response = await ctx.http(url)
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch {
    return { status: 0, body: undefined }
  }
}

interface Refs {
  readonly heads: ReadonlyMap<string, string>
  readonly notes: string | null
}

const readRefs = async (ctx: SeamContext, base: string): Promise<Refs | null> => {
  const answer = await readJson(ctx, `${base}/git/refs`)
  if (answer.status !== 200 || !Array.isArray(answer.body)) return null
  const heads = new Map<string, string>()
  let notes: string | null = null
  for (const ref of answer.body) {
    if (!isRecord(ref) || typeof ref.ref !== "string" || !isRecord(ref.object) || typeof ref.object.sha !== "string") continue
    if (ref.ref === MYTHICAL_NOTES_REF) notes = ref.object.sha
    else if (ref.ref.startsWith("refs/heads/")) heads.set(ref.ref.slice("refs/heads/".length), ref.object.sha)
  }
  return { heads, notes }
}

const readDefaultBookmark = async (ctx: SeamContext, base: string): Promise<string | null> => {
  const answer = await readJson(ctx, base)
  if (answer.status !== 200 || !isRecord(answer.body)) return null
  const bookmark = answer.body.default_bookmark
  return typeof bookmark === "string" && bookmark !== "" ? bookmark : null
}

/**
 * Reads change-feed pages, newest first, until `settled` is true, the feed
 * ends, or the page bound trips. The feed lists children before parents, so
 * every walk resolves a page at a time; `complete` is false only when the
 * bound (or a broken page) stopped the read before the walk settled.
 */
export const loadChanges = async (
  ctx: SeamContext,
  base: string,
  settled: (graph: ChangeGraph) => boolean,
  maxPages: number = MAX_CHANGE_PAGES
): Promise<{ readonly graph: ChangeGraph; readonly complete: boolean }> => {
  const graph = new ChangeGraph()
  let cursor = ""
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor !== "") query.set("cursor", cursor)
    const answer = await readJson(ctx, `${base}/changes?${query.toString()}`)
    if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.items)) {
      return { graph, complete: false }
    }
    for (const item of answer.body.items) {
      const row = parseChange(item)
      if (row !== null) graph.add(row)
    }
    if (settled(graph)) return { graph, complete: true }
    const next = answer.body.next_cursor
    if (typeof next !== "string" || next === "" || next === cursor || answer.body.items.length === 0) {
      return { graph, complete: settled(graph) }
    }
    cursor = next
  }
  return { graph, complete: settled(graph) }
}

/** The commit's tree sha off GET /git/commits/{sha}, or null when the mirror does not answer it (501 today). */
const readTreeSha = async (ctx: SeamContext, base: string, sha: string): Promise<string | null> => {
  const answer = await readJson(ctx, `${base}/git/commits/${encodeURIComponent(sha)}`)
  if (answer.status !== 200 || !isRecord(answer.body)) return null
  const tree = answer.body.tree
  return isRecord(tree) && typeof tree.sha === "string" && tree.sha !== "" ? tree.sha : null
}

/* ---- notes ---- */

const SECTION_NAMES = ["tried", "evidence", "folded", "superseded"] as const

/**
 * A note body: markdown with optional frontmatter and the four sections as
 * headings (any level, any case). A heading the note lacks is null; text
 * before the first heading belongs to no section.
 */
export const parseNote = (markdown: string): HistoryNote => {
  let text = markdown.replace(/\r\n/g, "\n")
  const frontmatter = /^---\n[\s\S]*?\n---\n?/.exec(text)
  if (frontmatter !== null) text = text.slice(frontmatter[0].length)
  const sections: Record<(typeof SECTION_NAMES)[number], string | null> = { tried: null, evidence: null, folded: null, superseded: null }
  let current: (typeof SECTION_NAMES)[number] | null = null
  const buffers = new Map<string, Array<string>>()
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+([A-Za-z]+)\s*$/.exec(line)
    if (heading !== null) {
      const name = heading[1]!.toLowerCase()
      current = (SECTION_NAMES as ReadonlyArray<string>).includes(name) ? (name as (typeof SECTION_NAMES)[number]) : null
      if (current !== null && !buffers.has(current)) buffers.set(current, [])
      continue
    }
    if (current !== null) buffers.get(current)!.push(line)
  }
  for (const name of SECTION_NAMES) {
    const lines = buffers.get(name)
    if (lines !== undefined) sections[name] = lines.join("\n").trim()
  }
  return sections
}

const decodeContent = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.content !== "string") return null
  if (body.encoding === "base64") {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (char) => char.charCodeAt(0)))
    } catch {
      return null
    }
  }
  return body.content
}

/**
 * The note for one commit: git notes store it at `<sha>` or fanned out at
 * `<2>/<38>` in the notes commit's tree, read through /contents against that
 * commit. Null when neither path exists.
 */
const readNote = async (ctx: SeamContext, base: string, notesSha: string, commitSha: string): Promise<HistoryNote | null> => {
  const paths = [commitSha, `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`]
  for (const path of paths) {
    const answer = await readJson(ctx, `${base}/contents/${path}?ref=${encodeURIComponent(notesSha)}`)
    if (answer.status !== 200) continue
    const content = decodeContent(answer.body)
    if (content !== null) return parseNote(content)
  }
  return null
}

/* ---- the read ---- */

const unsupported = (reason: string): Mythical => ({ state: "unsupported", reason })

export const readHistory = async (ctx: SeamContext, repo: string): Promise<HistoryPayload | { readonly error: string }> => {
  const base = repoBase(ctx, repo)
  const [refs, defaultBookmark] = await Promise.all([readRefs(ctx, base), readDefaultBookmark(ctx, base)])
  if (refs === null) return { error: `The history of ${repo} couldn't be read: the mirror did not list its refs.` }
  const mainHead = defaultBookmark === null ? null : refs.heads.get(defaultBookmark) ?? null
  const mythicalHead = refs.heads.get("mythical") ?? null

  if (mythicalHead === null) {
    const { graph, complete } = mainHead === null
      ? { graph: new ChangeGraph(), complete: false }
      : await loadChanges(ctx, base, (loaded) => loaded.ancestors(mainHead) !== null)
    const mainCommits = complete && mainHead !== null ? graph.ancestors(mainHead)?.length ?? null : null
    return { repo, defaultBookmark, mainCommits, mythical: { state: "absent" } }
  }

  const settled = (graph: ChangeGraph): boolean => {
    const line = graph.firstParentLine(mythicalHead)
    if (line === null) return false
    const lineIds = new Set(line.map((row) => row.changeId))
    if (line.some((row) => row.parents.length > 1 && graph.secondParentChain(row, lineIds) === null)) return false
    return mainHead === null || graph.ancestors(mainHead) !== null
  }
  const { graph, complete } = await loadChanges(ctx, base, settled)
  const line = graph.firstParentLine(mythicalHead)
  if (line === null) {
    return {
      repo,
      defaultBookmark,
      mainCommits: null,
      mythical: unsupported(`The mirror's change feed did not reach every commit of mythical within ${MAX_CHANGE_PAGES} pages.`)
    }
  }
  const mainCommits = complete && mainHead !== null ? graph.ancestors(mainHead)?.length ?? null : null
  const lineIds = new Set(line.map((row) => row.changeId))

  const [mythicalTree, mainTree] = await Promise.all([
    readTreeSha(ctx, base, mythicalHead),
    mainHead === null ? Promise.resolve(null) : readTreeSha(ctx, base, mainHead)
  ])
  const treeEqual = mythicalTree === null || mainTree === null ? "unsupported" : mythicalTree === mainTree ? "equal" : "different"

  const noteFor = new Map<string, HistoryNote | null>()
  const shas: Array<string> = []
  const epicsRaw = line.map((row) => {
    const chain = row.parents.length > 1 ? graph.secondParentChain(row, lineIds) ?? [] : []
    shas.push(row.commitId, ...chain.map((commit) => commit.commitId))
    return { row, chain }
  })
  if (refs.notes !== null) {
    const notesSha = refs.notes
    const read = await Promise.all(shas.slice(0, NOTE_READ_CAP).map(async (sha) => [sha, await readNote(ctx, base, notesSha, sha)] as const))
    for (const [sha, note] of read) noteFor.set(sha, note)
  }
  const epics: Array<HistoryEpic> = epicsRaw.map(({ row, chain }) => ({
    sha: row.commitId,
    title: row.title,
    merge: row.parents.length > 1,
    note: noteFor.get(row.commitId) ?? null,
    commits: chain.map((commit) => ({ sha: commit.commitId, title: commit.title, note: noteFor.get(commit.commitId) ?? null }))
  }))
  return {
    repo,
    defaultBookmark,
    mainCommits,
    mythical: {
      state: "present",
      head: mythicalHead,
      mainHead,
      treeEqual,
      commitCount: shas.length,
      notes: refs.notes === null ? "absent" : "read",
      epics
    }
  }
}

export const createHistorySeam = (ctx: SeamContext): HistorySeam => {
  /* One history card per repository, re-surfaced at the end of the transcript on every show. */
  const showHistory = async (repoArg?: string): Promise<string | void> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const payload = await readHistory(ctx, target.repo)
    if ("error" in payload) return payload.error
    const card: Card = {
      id: `history-${target.repo}`,
      kind: "history",
      title: `Mythical history · ${target.repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /*
   * The write doors refuse with the empty state's own sentence until the
   * retell flow exists: no rewrite of mythical happens from this app today.
   */
  const retellHistory = async (_door: "bootstrap" | "amend" | "fold", repoArg?: string): Promise<string | void> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const payload = await readHistory(ctx, target.repo)
    if ("error" in payload) return payload.error
    if (payload.mythical.state === "absent") return emptyHistorySentence(payload.defaultBookmark, payload.mainCommits)
    return `The mythical history of ${target.repo} cannot be rewritten from here yet: the retell flow does not exist.`
  }

  return { showHistory, retellHistory }
}
