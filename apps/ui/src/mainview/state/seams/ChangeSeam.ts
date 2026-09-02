/*
 * The changes seam (lane change, ADR 0003 — the change is the unit), behind
 * the `/api/cloud/*` proxy:
 *
 *   GET /api/repos/{o}/{r}/changes/{change_id}            — the change DTO (one commit_id, NO revisions — plue#450)
 *   GET /api/repos/{o}/{r}/changes/{change_id}/diff       — change vs its parent (interdiff is plue#451)
 *   GET /api/repos/{o}/{r}/changes/{change_id}/conflicts  — per-file conflicts
 *   GET /api/repos/{o}/{r}/landings?limit=100             — the landing requests; change_ids names the stack
 *   GET /api/repos/{o}/{r}/landings/{n}/reviews|comments  — verdicts and threads (no commit_id, no anchor state — plue#453)
 *   GET /api/repos/{o}/{r}/commits/{ref}/statuses?limit=100 — the checks at one commit
 *   PUT /api/repos/{o}/{r}/landings/{n}/land              — lands the request's WHOLE stack; QUEUED, never "merged"
 *   GET /api/orgs/{org}/changesets                        — the live changeset DTO (ADR 0003)
 *   POST /api/orgs/{org}/changesets/{id}/land             — synchronous; 409 carries failure_reason
 *
 * What does NOT exist and is never faked: revisions[] (#450), interdiff
 * (#451), landable_prefix / blocked_by (#452), commit_id on verdicts and
 * anchor state on threads (#453), findings per revision (#454), conflict
 * resolve via agent (#455), revert (#456), per-change operations (#457).
 * The card renders the ADR's degraded wording for each.
 *
 * Reads need only the legacy token's read:repository, so a degraded sign-in
 * reads freely; dispatching an agent (change.resolve) is the act that
 * refuses it with the enable wording.
 */
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import type { ChangeFacet, ChangeThread, ChangeVerdict, ChangesetState, DiffFile } from "smithers-shared/Changes"
import { changeRowId } from "../AppState"
import type { Card, ChangeInput } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export const DEGRADED_CHANGE_REFUSAL =
  "This Smithers Cloud sign-in can't dispatch agents — sign in again to enable them."

const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

/** The degraded refusals for the routes that do not exist (ADR 0003 "Filed"). */
export const NO_REVISIONS_REFUSAL =
  "A change's revision history isn't recorded yet (plue#450) — /change.view <changeId> shows the current revision."
export const NO_INTERDIFF_REFUSAL =
  "A diff between two revisions (an interdiff) doesn't exist yet (plue#451) — the diff offers parent → current only."
export const NO_SPLIT_REFUSAL =
  "Which members of a changeset are ready to land isn't recorded yet (plue#452) — a split can't be computed honestly."
export const NO_RESOLVE_REFUSAL =
  "Resolving a conflict with an agent doesn't exist yet (plue#455) — the backend has no route, so no run was dispatched."
export const NO_REVERT_REFUSAL =
  "Reverting a landed change doesn't exist yet (plue#456) — no revert change was created."

/** Past this many patch lines a file's hunk rides by reference (ADR 0003 step 1), never inline. */
const INLINE_PATCH_LINE_CAP = 400

export interface ChangeSeam {
  /** `change.view <changeId> [rev]`: read the change and its auxiliaries, render the card. */
  readonly viewChange: (changeId: string, rev?: number, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `change.diff <changeId> [from] [to] [path]`: render the diff card at the two pins. */
  readonly diffChange: (
    changeId: string,
    from?: string,
    to?: string,
    path?: string,
    repo?: string
  ) => Promise<string | void | { readonly value: string }>
  /** `change.land <changeId>`: land the carrying landing request (queued) or the changeset (synchronous). */
  readonly landChange: (changeId: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `change.split-ready <changeId>`: refuses honestly until plue#452 names the ready members. */
  readonly splitReady: (changeId: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `change.resolve <changeId> <path>`: refuses honestly until plue#455 exists; a degraded sign-in can't dispatch agents. */
  readonly resolveConflict: (changeId: string, path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `change.revert <changeId>`: only on a landed change; refuses honestly until plue#456 exists. */
  readonly revertChange: (changeId: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** The card's body tab; hidden, card-button scoped. */
  readonly setFacet: (changeId: string, facet: ChangeFacet, repo?: string) => Promise<string | void>
}

interface RepoStat {
  readonly repo: string
  readonly additions: number
  readonly deletions: number
}

interface CheckRow {
  readonly context: string
  readonly state: string
}

interface ConflictRow {
  readonly path: string
  readonly state: string
}

interface StackRow {
  readonly landingNumber: number
  readonly state: string
  readonly position: number
  readonly size: number
  /** The request's change ids in request order; the last is the top. */
  readonly changeIds: Array<string>
  readonly targetBookmark: string
  readonly conflictStatus: string
}

type ChangePayload = Extract<Card, { readonly kind: "change" }>["payload"]
/** Why an auxiliary is null, keyed by the auxiliary (Cards.ts `unread`). */
type ChangeUnread = NonNullable<ChangePayload["unread"]>

/**
 * A read's answer: the value, or why it was not read, in the platform's own
 * words. An unread answer is never a fact — the card says "not read (why)",
 * never "none".
 */
type Read<T> = { readonly value: T } | { readonly unread: string }

/** The auxiliaries a change card renders beside the DTO row. */
interface ChangeAux {
  readonly repos: ReadonlyArray<RepoStat>
  readonly diff: { readonly from: string; readonly to: string; readonly files: Array<DiffFile> } | null
  readonly checks: ReadonlyArray<CheckRow> | null
  readonly reviews: ReadonlyArray<ChangeVerdict> | null
  readonly threads: ReadonlyArray<ChangeThread> | null
  readonly conflicts: ReadonlyArray<ConflictRow> | null
  readonly stack: StackRow | null
  readonly changeset: ChangesetState | null
  readonly unread: ChangeUnread
  readonly facet?: ChangeFacet | undefined
  readonly error?: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/** The list a route answers: a bare array, or one under a named key. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  return []
}

/** One change row off the wire (today's DTO: one commit, no revisions); malformed rows drop. */
const parseChangeWire = (value: unknown, repoId: string): ChangeInput | null => {
  if (!isRecord(value)) return null
  const changeId = str(value.change_id)
  if (changeId === null) return null
  return {
    id: changeRowId(repoId, changeId),
    repoId,
    changeId,
    commitId: str(value.commit_id),
    description: typeof value.description === "string" ? value.description : "",
    authorName: str(value.author_name),
    timestamp: str(value.timestamp),
    hasConflict: value.has_conflict === true,
    parentChangeIds: Array.isArray(value.parent_change_ids)
      ? value.parent_change_ids.filter((id): id is string => typeof id === "string")
      : [],
    currentSeq: null,
    revisionCount: null
  }
}

/** One file of the diff route's answer; the hunk inlines only under the cap. */
const parseDiffFile = (value: unknown, includePatch: boolean): DiffFile | null => {
  if (!isRecord(value)) return null
  const path = str(value.path)
  if (path === null) return null
  const patch = str(value.patch)
  const patchLines = patch === null ? 0 : patch.split("\n").length
  const inline = patch !== null && (includePatch || patchLines <= INLINE_PATCH_LINE_CAP)
  return {
    path,
    ...(str(value.old_path) === null ? {} : { oldPath: str(value.old_path) as string }),
    changeType: str(value.change_type) ?? "modified",
    isBinary: value.is_binary === true,
    additions: intOrNull(value.additions) ?? 0,
    deletions: intOrNull(value.deletions) ?? 0,
    ...(inline ? { patch: patch as string } : patch === null ? {} : { patchLines })
  }
}

/** One conflict row off the wire; a missing resolution status reads "unresolved". */
const parseConflict = (value: unknown): ConflictRow | null => {
  if (!isRecord(value)) return null
  const path = str(value.file_path)
  if (path === null) return null
  return { path, state: str(value.resolution_status) ?? "unresolved" }
}

/** One landing request row off the wire (the list carries change_ids and stack_size). */
const parseLanding = (
  value: unknown
): { readonly number: number; readonly state: string; readonly changeIds: ReadonlyArray<string>; readonly targetBookmark: string; readonly conflictStatus: string } | null => {
  if (!isRecord(value)) return null
  const number = intOrNull(value.number)
  if (number === null) return null
  return {
    number,
    state: str(value.state) ?? "unknown",
    changeIds: Array.isArray(value.change_ids) ? value.change_ids.filter((id): id is string => typeof id === "string") : [],
    targetBookmark: str(value.target_bookmark) ?? "main",
    conflictStatus: str(value.conflict_status) ?? "unknown"
  }
}

/** A review verdict; plue exposes reviewer_id, not a login, and no commit_id (plue#453). */
const parseReview = (value: unknown): ChangeVerdict | null => {
  if (!isRecord(value)) return null
  const type = str(value.type)
  if (type === null) return null
  return { author: str(value.reviewer_login), type, body: typeof value.body === "string" ? value.body : "", commitId: null }
}

/** A comment thread; no anchor state until plue#453 computes one. */
const parseComment = (value: unknown): ChangeThread | null => {
  if (!isRecord(value)) return null
  return {
    path: str(value.path),
    line: intOrNull(value.line),
    body: typeof value.body === "string" ? value.body : "",
    author: null,
    createdAt: str(value.created_at),
    state: null
  }
}

/** One check row off the statuses route. */
const parseCheck = (value: unknown): (CheckRow & { readonly createdAt: string }) | null => {
  if (!isRecord(value)) return null
  const context = str(value.context)
  const state = str(value.status)
  if (context === null || state === null) return null
  return { context, state, createdAt: str(value.created_at) ?? "" }
}

/*
 * Status rows repeat contexts across re-runs and arrive created_at DESC, so
 * the NEWEST row per context wins, decided by created_at — a naive
 * last-write-wins keeps the OLDEST row and shows "pending" forever after a
 * green re-run.
 */
const newestPerContext = (rows: ReadonlyArray<CheckRow & { readonly createdAt: string }>): Array<CheckRow> => {
  const byContext = new Map<string, CheckRow & { readonly createdAt: string }>()
  for (const row of rows) {
    const existing = byContext.get(row.context)
    if (existing === undefined || row.createdAt > existing.createdAt) byContext.set(row.context, row)
  }
  return [...byContext.values()].map(({ context, state }) => ({ context, state }))
}

/** One changeset row off the live DTO (ADR 0003); malformed rows drop. */
const parseChangeset = (value: unknown): ChangesetState | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  const organization = str(value.organization)
  const state = str(value.state)
  if (id === null || organization === null || state === null) return null
  if (state !== "pending" && state !== "landing" && state !== "landed" && state !== "failed") return null
  return {
    id,
    organization,
    superproject: str(value.superproject) ?? "",
    changeId: str(value.change_id) ?? "",
    state,
    failureReason: str(value.failure_reason),
    targetBookmark: str(value.target_bookmark) ?? "main",
    members: arrayOf(value.members, "members").flatMap((member) => {
      if (!isRecord(member)) return []
      const repository = str(member.repository)
      const path = str(member.path)
      const changeId = str(member.change_id)
      const commitId = str(member.commit_id)
      if (repository === null || path === null || changeId === null || commitId === null) return []
      return [{
        repository,
        path,
        changeId,
        commitId,
        targetBookmark: str(member.target_bookmark) ?? "main",
        previousCommitId: str(member.previous_commit_id),
        landedCommitId: str(member.landed_commit_id)
      }]
    })
  }
}

/*
 * The changeset this change belongs to, scoped by REPOSITORY: a jj change id
 * is per-repo and nothing stops two repos from holding the same id, so a
 * bare id match could attach — and land — another repo's changeset. A match
 * is `superproject · change_id` or `member.repository · member.change_id`;
 * plue spells both `org/name` (changeset.go), which is the app's repo id.
 */
const changesetFor = (
  changesets: ReadonlyArray<ChangesetState>,
  repoId: string,
  changeId: string
): ChangesetState | null =>
  changesets.find((changeset) =>
    (changeset.superproject === repoId && changeset.changeId === changeId)
    || changeset.members.some((member) => member.repository === repoId && member.changeId === changeId)
  ) ?? null

const cardIdOf = (repoId: string, changeId: string): string => `change-${repoId}-${changeId}`
const diffCardIdOf = (repoId: string, changeId: string): string => `diff-${repoId}-${changeId}`

export const createChangeSeam = (ctx: SeamContext): ChangeSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  const repoPath = (repoId: string, rest: string): string => {
    const [owner = "", name = ""] = repoId.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`
  }

  /* Reads need only the legacy token's read:repository — a definitive signed-in answer is the gate. */
  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
  }

  const getJson = async (path: string): Promise<{ readonly body: unknown } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(path))
    } catch (error) {
      return { error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!response.ok) return { error: await readErrorMessage(response, `Reading ${path} failed (${response.status})`) }
    return { body: await response.json().catch(() => null) }
  }

  const sendJson = async (
    method: "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ readonly body: unknown; readonly status: number } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(path), {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      })
    } catch (error) {
      return { error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!response.ok) return { error: await readErrorMessage(response, `The ${method} to ${path} failed (${response.status})`) }
    return { body: await response.json().catch(() => null), status: response.status }
  }

  /*
   * The repository a change act routes through: the explicit one, else the
   * changes collection's record of this change, else the app's target repo
   * (the active selection, or the single loaded repository). Never a guess.
   */
  const resolveRepo = (
    changeId: string,
    repo?: string
  ): { readonly repo: string } | { readonly error: string } => {
    if (repo !== undefined && repo !== "") {
      const target = resolveTargetRepo(ctx.store, repo)
      return "error" in target ? target : { repo: target.repo }
    }
    for (const row of ctx.store.collections.changes.values()) {
      if (row.changeId === changeId) return { repo: row.repoId }
    }
    const target = resolveTargetRepo(ctx.store, undefined)
    return "error" in target ? target : { repo: target.repo }
  }

  /* ---- the auxiliaries: absent answers, never inventions ---- */

  /** The per-file conflicts. */
  const loadConflicts = async (repoId: string, changeId: string): Promise<Read<ReadonlyArray<ConflictRow>>> => {
    const answer = await getJson(repoPath(repoId, `/changes/${encodeURIComponent(changeId)}/conflicts`))
    if ("error" in answer) return { unread: answer.error }
    return {
      value: arrayOf(answer.body, "conflicts").flatMap((entry) => {
        const parsed = parseConflict(entry)
        return parsed === null ? [] : [parsed]
      })
    }
  }

  interface DiffRead {
    readonly files: Array<DiffFile>
    readonly stat: RepoStat
  }

  /** The change-vs-parent diff. `path` cuts to one file, its hunk inline regardless of size. */
  const loadDiff = async (repoId: string, changeId: string, path?: string): Promise<Read<DiffRead>> => {
    const answer = await getJson(repoPath(repoId, `/changes/${encodeURIComponent(changeId)}/diff`))
    if ("error" in answer) return { unread: answer.error }
    if (!isRecord(answer.body)) return { unread: `Smithers Cloud's answer for the diff of ${changeId} was malformed` }
    const files = arrayOf(answer.body.file_diffs, "file_diffs").flatMap((entry) => {
      const parsed = parseDiffFile(entry, path !== undefined)
      return parsed === null || (path !== undefined && parsed.path !== path) ? [] : [parsed]
    })
    let additions = 0
    let deletions = 0
    for (const file of files) {
      additions += file.additions
      deletions += file.deletions
    }
    return { value: { files, stat: { repo: repoId, additions, deletions } } }
  }

  interface LandingHit {
    readonly landing: NonNullable<ReturnType<typeof parseLanding>>
    readonly position: number
  }

  /*
   * The landing request whose stack carries this change; a read `null` means
   * no request does. `position` is the change's 1-based index in the
   * request's `change_ids` — REQUEST ORDER, the order the request's author
   * submitted (plue landing.go `normalizeChangeIDs` trims and keeps it;
   * nothing sorts it into stack order). It is an inference the card labels
   * "by request order" until plue#450's `stack.position` is read.
   */
  const loadLanding = async (repoId: string, changeId: string): Promise<Read<LandingHit | null>> => {
    const answer = await getJson(repoPath(repoId, "/landings?limit=100"))
    if ("error" in answer) return { unread: answer.error }
    for (const entry of arrayOf(answer.body, "items")) {
      const landing = parseLanding(entry)
      if (landing === null) continue
      const index = landing.changeIds.indexOf(changeId)
      if (index !== -1) return { value: { landing, position: index + 1 } }
    }
    return { value: null }
  }

  /** Verdicts on the landing. */
  const loadReviews = async (repoId: string, landingNumber: number): Promise<Read<ReadonlyArray<ChangeVerdict>>> => {
    const answer = await getJson(repoPath(repoId, `/landings/${landingNumber}/reviews?limit=100`))
    if ("error" in answer) return { unread: answer.error }
    return {
      value: arrayOf(answer.body, "reviews").flatMap((entry) => {
        const parsed = parseReview(entry)
        return parsed === null ? [] : [parsed]
      })
    }
  }

  /** Threads on the landing. */
  const loadComments = async (repoId: string, landingNumber: number): Promise<Read<ReadonlyArray<ChangeThread>>> => {
    const answer = await getJson(repoPath(repoId, `/landings/${landingNumber}/comments?limit=100`))
    if ("error" in answer) return { unread: answer.error }
    return {
      value: arrayOf(answer.body, "comments").flatMap((entry) => {
        const parsed = parseComment(entry)
        return parsed === null ? [] : [parsed]
      })
    }
  }

  /** The checks at one commit, newest per context. */
  const loadChecks = async (repoId: string, commitId: string | null): Promise<Read<ReadonlyArray<CheckRow>>> => {
    if (commitId === null) return { unread: "the change carries no commit id to read statuses at" }
    const answer = await getJson(repoPath(repoId, `/commits/${encodeURIComponent(commitId)}/statuses?limit=100`))
    if ("error" in answer) return { unread: answer.error }
    return {
      value: newestPerContext(
        arrayOf(answer.body, "statuses").flatMap((entry) => {
          const parsed = parseCheck(entry)
          return parsed === null ? [] : [parsed]
        })
      )
    }
  }

  /** The org's changesets, when the repository's owner IS an org; a read `null` means none carries this change here. */
  const loadChangeset = async (repoId: string, changeId: string): Promise<Read<ChangesetState | null>> => {
    const repository = ctx.store.collections.repositories.get(repoId)
    if (repository?.ownerKind !== "org") return { value: null }
    const answer = await getJson(`/orgs/${encodeURIComponent(repository.org)}/changesets`)
    if ("error" in answer) return { unread: answer.error }
    return {
      value: changesetFor(
        arrayOf(answer.body, "changesets").flatMap((entry) => {
          const parsed = parseChangeset(entry)
          return parsed === null ? [] : [parsed]
        }),
        repoId,
        changeId
      )
    }
  }

  /* ---- the card ---- */

  /*
   * Render one change's card: the DTO row plus the auxiliaries. An override
   * wins; otherwise the existing card's value stands, so a facet switch
   * never blanks what the view loaded.
   */
  const renderChange = (change: ChangeInput, overrides: Partial<ChangeAux> = {}): void => {
    const id = cardIdOf(change.repoId, change.changeId)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "change" ? existing.payload : undefined
    const payload = {
      repo: change.repoId,
      changeId: change.changeId,
      description: change.description,
      commitId: change.commitId,
      currentSeq: change.currentSeq,
      revisionCount: change.revisionCount,
      revisions: prior?.revisions ?? [],
      authorName: change.authorName,
      timestamp: change.timestamp,
      repos: overrides.repos !== undefined ? [...overrides.repos] : prior?.repos ?? [],
      diff: overrides.diff !== undefined ? overrides.diff : prior?.diff ?? null,
      checks: overrides.checks !== undefined ? (overrides.checks === null ? null : [...overrides.checks]) : prior?.checks ?? null,
      findings: prior?.findings ?? null,
      reviews: overrides.reviews !== undefined ? overrides.reviews === null ? null : [...overrides.reviews] : prior?.reviews ?? null,
      threads: overrides.threads !== undefined ? overrides.threads === null ? null : [...overrides.threads] : prior?.threads ?? null,
      conflicts: overrides.conflicts !== undefined
        ? (overrides.conflicts === null ? null : [...overrides.conflicts])
        : prior?.conflicts ?? null,
      stack: overrides.stack !== undefined ? overrides.stack : prior?.stack ?? null,
      changeset: overrides.changeset !== undefined ? overrides.changeset : prior?.changeset ?? null,
      ...(overrides.unread !== undefined
        ? (Object.keys(overrides.unread).length === 0 ? {} : { unread: overrides.unread })
        : prior?.unread !== undefined ? { unread: prior.unread } : {}),
      ...(overrides.facet !== undefined
        ? { facet: overrides.facet }
        : prior?.facet !== undefined ? { facet: prior.facet } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {})
    }
    const firstLine = change.description.split("\n")[0] ?? change.changeId
    const card: Card = {
      id,
      kind: "change",
      title: `${change.changeId} · ${firstLine === "" ? change.repoId : firstLine}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /* The whole read: the change, then its auxiliaries in parallel, then the card. */
  const surfaceChange = async (
    repoId: string,
    changeId: string,
    overrides: Partial<ChangeAux> = {}
  ): Promise<string | void> => {
    const answer = await getJson(repoPath(repoId, `/changes/${encodeURIComponent(changeId)}`))
    if ("error" in answer) return answer.error
    const change = parseChangeWire(answer.body, repoId)
    if (change === null) return `Smithers Cloud's answer for change ${changeId} was malformed.`
    ctx.dispatch({ type: "change.loaded", actor: "system", change })
    /*
     * ONE retention rule for every auxiliary: this read writes each of them
     * from its own answer — the value when the route answered, null plus the
     * reason in `unread` when it did not — and nothing from an earlier read
     * survives it. A transient failure can therefore never leave a stale
     * "Conflicted" line or Land scope standing, nor a blank that reads as
     * "no checks". Only a no-read act (change.facet) keeps the prior
     * payload, through renderChange's fallback.
     */
    const [conflicts, diff, landing, changeset] = await Promise.all([
      loadConflicts(repoId, changeId),
      loadDiff(repoId, changeId),
      loadLanding(repoId, changeId),
      loadChangeset(repoId, changeId)
    ])
    /* Verdicts and threads live on the landing request: unread when its list was, [] when no request carries the change. */
    const hit = "unread" in landing ? null : landing.value
    const withoutLanding: Read<ReadonlyArray<never>> = "unread" in landing
      ? { unread: `the landing list wasn't read: ${landing.unread}` }
      : { value: [] }
    const [checks, reviews, threads] = await Promise.all([
      loadChecks(repoId, change.commitId),
      hit === null ? Promise.resolve(withoutLanding) : loadReviews(repoId, hit.landing.number),
      hit === null ? Promise.resolve(withoutLanding) : loadComments(repoId, hit.landing.number)
    ])
    renderChange(change, {
      conflicts: "unread" in conflicts ? null : conflicts.value,
      repos: "unread" in diff ? [] : [diff.value.stat],
      diff: "unread" in diff ? null : { from: "parent", to: "current", files: diff.value.files },
      checks: "unread" in checks ? null : checks.value,
      reviews: "unread" in reviews ? null : reviews.value,
      threads: "unread" in threads ? null : threads.value,
      stack: hit === null ? null : {
        landingNumber: hit.landing.number,
        state: hit.landing.state,
        position: hit.position,
        size: Math.max(hit.landing.changeIds.length, 1),
        changeIds: [...hit.landing.changeIds],
        targetBookmark: hit.landing.targetBookmark,
        conflictStatus: hit.landing.conflictStatus
      },
      changeset: "unread" in changeset ? null : changeset.value,
      unread: {
        ...("unread" in diff ? { diff: diff.unread } : {}),
        ...("unread" in conflicts ? { conflicts: conflicts.unread } : {}),
        ...("unread" in checks ? { checks: checks.unread } : {}),
        ...("unread" in reviews ? { reviews: reviews.unread } : {}),
        ...("unread" in threads ? { threads: threads.unread } : {}),
        ...("unread" in landing ? { stack: landing.unread } : {}),
        ...("unread" in changeset ? { changeset: changeset.unread } : {})
      },
      ...overrides
    })
    return
  }

  /* ---- the acts ---- */

  const viewChange: ChangeSeam["viewChange"] = async (changeId, rev, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    if (changeId.trim() === "") return "change.view needs a change id: /change.view <changeId>"
    if (rev !== undefined) return NO_REVISIONS_REFUSAL
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const error = await surfaceChange(resolved.repo, changeId)
    if (error !== undefined) return error
    return { value: `Change ${changeId} on ${resolved.repo} — the card tracks it.` }
  }

  const diffChange: ChangeSeam["diffChange"] = async (changeId, from, to, path, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    if (changeId.trim() === "") return "change.diff needs a change id: /change.diff <changeId>"
    const fromPin = from === undefined || from === "" ? "parent" : from
    const toPin = to === undefined || to === "" ? "current" : to
    /* Only change-vs-parent has a route today; the interdiff is plue#451 on top of plue#450's revisions. */
    if (fromPin !== "parent" || toPin !== "current") return NO_INTERDIFF_REFUSAL
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const answer = await getJson(repoPath(resolved.repo, `/changes/${encodeURIComponent(changeId)}`))
    if ("error" in answer) return answer.error
    const change = parseChangeWire(answer.body, resolved.repo)
    if (change === null) return `Smithers Cloud's answer for change ${changeId} was malformed.`
    ctx.dispatch({ type: "change.loaded", actor: "system", change })
    const [conflicts, diff] = await Promise.all([
      loadConflicts(resolved.repo, changeId),
      loadDiff(resolved.repo, changeId, path === undefined || path === "" ? undefined : path)
    ])
    if ("unread" in diff) return `The diff of change ${changeId} on ${resolved.repo} couldn't be read right now (${diff.unread}).`
    /* Unread conflicts mark no file; the change card is where an unread conflicts list is reported. */
    const conflicted = new Set(("unread" in conflicts ? [] : conflicts.value).map((conflict) => conflict.path))
    const files = [...diff.value.files]
      .map((file) => (conflicted.has(file.path) ? { ...file, conflicted: true } : file))
      .sort((left, right) => Number(right.conflicted === true) - Number(left.conflicted === true))
    const id = diffCardIdOf(resolved.repo, changeId)
    const existing = ctx.store.collections.cards.get(id)
    const card: Card = {
      id,
      kind: "diff",
      title: `${changeId} · ${fromPin} → ${toPin}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        repo: resolved.repo,
        changeId,
        from: fromPin,
        to: toPin,
        pin: { changeId, seq: change.currentSeq, commitId: change.commitId },
        files,
        ...(path === undefined || path === "" ? {} : { path })
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return { value: `Diff of ${changeId} (${fromPin} → ${toPin}) — ${files.length} file${files.length === 1 ? "" : "s"}.` }
  }

  const landChange: ChangeSeam["landChange"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const repoId = resolved.repo
    /* A changeset lands atomically through its own route — never partially; an unread list can't clear the change of one. */
    const changesetRead = await loadChangeset(repoId, changeId)
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}) — nothing was landed.`
    }
    const changeset = changesetRead.value
    if (changeset !== null) {
      if (changeset.state === "landing") {
        return `Changeset ${changeset.id} is landing — the card tracks it.`
      }
      if (changeset.state === "landed") {
        return `Changeset ${changeset.id} already landed.`
      }
      const landed = await sendJson("POST", `/orgs/${encodeURIComponent(changeset.organization)}/changesets/${changeset.id}/land`)
      if ("error" in landed) {
        /* A 409 restores every member bookmark; the row's failure_reason is the honest line. */
        await surfaceChange(repoId, changeId)
        return landed.error
      }
      const refreshed = parseChangeset(landed.body)
      const error = await surfaceChange(repoId, changeId, refreshed === null ? {} : { changeset: refreshed })
      if (error !== undefined) return error
      return { value: `Changeset ${changeset.id} landed — every member bookmark moved together.` }
    }
    const landingRead = await loadLanding(repoId, changeId)
    if ("unread" in landingRead) {
      return `The landing requests of ${repoId} weren't read (${landingRead.unread}) — nothing was landed.`
    }
    if (landingRead.value === null) {
      return `No landing request carries ${changeId} on ${repoId} — /prs.create opens one.`
    }
    const { landing, position } = landingRead.value
    const size = landing.changeIds.length
    const top = landing.changeIds[size - 1] ?? changeId
    /*
     * PUT /landings/{n}/land lands the request's WHOLE stack. The ADR's
     * prefix land from a mid-stack change ("lands 1 → 2") needs plue#452's
     * landable_prefix, so until it is read a mid-stack change refuses and
     * names the blast radius, and the top change's land states the full
     * scope in its own line — never a silent over-land.
     */
    if (position < size) {
      return `Landing request #${landing.number} lands its whole stack together (1 → ${size}: ${
        landing.changeIds.join(", ")
      }) — ${changeId} is ${position} of ${size} by request order, and landing a prefix alone isn't possible yet (plue#452). /change.land ${top} lands all ${size}.`
    }
    /* plue lands a request only while it is open or failed (landing.go LandLandingRequest). */
    if (landing.state !== "open" && landing.state !== "failed") {
      return `Landing request #${landing.number} is ${landing.state} — plue lands a request only while it is open or failed; the card tracks it.`
    }
    const queued = await sendJson("PUT", repoPath(repoId, `/landings/${landing.number}/land`))
    if ("error" in queued) return queued.error
    /*
     * 202/200: the land is QUEUED, never a terminal claim the platform hasn't
     * made. The re-read renders the state the platform answers; the line
     * names the scope the PUT covered.
     */
    const error = await surfaceChange(repoId, changeId)
    if (error !== undefined) return error
    const scope = size <= 1 ? `${changeId} alone` : `1 → ${size} together (${landing.changeIds.join(", ")})`
    return { value: `Landing request #${landing.number} is queued — it lands ${scope}; the card tracks it.` }
  }

  const splitReady: ChangeSeam["splitReady"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const changesetRead = await loadChangeset(resolved.repo, changeId)
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}).`
    }
    if (changesetRead.value === null) {
      return `Split ready members applies to a changeset — ${changeId} on ${resolved.repo} belongs to none.`
    }
    return NO_SPLIT_REFUSAL
  }

  const resolveConflict: ChangeSeam["resolveConflict"] = async (changeId, path, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.scopes === "degraded") return DEGRADED_CHANGE_REFUSAL
    if (path.trim() === "") return "change.resolve needs the conflicted file's path: /change.resolve <changeId> <path>"
    void repo
    void changeId
    return NO_RESOLVE_REFUSAL
  }

  const revertChange: ChangeSeam["revertChange"] = async (changeId, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    /* Revert is offered only on a landed change: the carrying landing's terminal state, or the changeset's. */
    const changesetRead = await loadChangeset(resolved.repo, changeId)
    if ("unread" in changesetRead) {
      return `The changesets ${changeId} might belong to weren't read (${changesetRead.unread}).`
    }
    const changeset = changesetRead.value
    if (changeset !== null) {
      if (changeset.state !== "landed") {
        return `Revert is offered on a landed change — changeset ${changeset.id} is ${changeset.state}.`
      }
      return NO_REVERT_REFUSAL
    }
    const landingRead = await loadLanding(resolved.repo, changeId)
    if ("unread" in landingRead) {
      return `The landing requests of ${resolved.repo} weren't read (${landingRead.unread}).`
    }
    const landing = landingRead.value
    if (landing === null || landing.landing.state !== "merged") {
      return `Revert is offered on a landed change — ${changeId} has not landed${
        landing === null ? "" : ` (the landing request is ${landing.landing.state})`
      }.`
    }
    return NO_REVERT_REFUSAL
  }

  const setFacet: ChangeSeam["setFacet"] = async (changeId, facet, repo) => {
    const resolved = resolveRepo(changeId, repo)
    if ("error" in resolved) return resolved.error
    const row = [...ctx.store.collections.changes.values()].find((candidate) => candidate.changeId === changeId)
    if (row === undefined) return `Change ${changeId} is not loaded — /change.view ${changeId} reads it first`
    renderChange(row, { facet })
    return
  }

  return {
    viewChange,
    diffChange,
    landChange,
    splitReady,
    resolveConflict,
    revertChange,
    setFacet
  }
}
