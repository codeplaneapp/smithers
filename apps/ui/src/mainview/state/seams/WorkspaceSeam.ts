/*
 * The workspaces seam (lane citc, ADR 0002): the persistent cloud computers
 * behind the `/api/cloud/*` proxy.
 *
 *   GET    /api/user/workspaces                          — the per-user list
 *   GET    /api/repos/{o}/{r}/workspaces                 — one repository's list
 *   POST   /api/repos/{o}/{r}/workspaces                 — create-or-reuse { name?, snapshot_id?, source_bookmark? }
 *   GET    /api/repos/{o}/{r}/workspaces/{id}
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/suspend|resume
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/fork       { name }
 *   DELETE /api/repos/{o}/{r}/workspaces/{id}
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/snapshot   { name }
 *   GET    /api/repos/{o}/{r}/workspace-snapshots
 *   GET    /api/repos/{o}/{r}/workspace-snapshots/{id}
 *   DELETE /api/repos/{o}/{r}/workspace-snapshots/{id}
 *   POST   /api/repos/{o}/{r}/workspace-snapshots        { workspace_id, name } — a template
 *   GET    /api/repos/{o}/{r}/workspace/sessions         { workspace_id }
 *   POST   /api/repos/{o}/{r}/workspace/sessions         { workspace_id, cols, rows }
 *   GET    /api/repos/{o}/{r}/workspace/sessions/{id}
 *   POST   /api/repos/{o}/{r}/workspace/sessions/{id}/destroy
 *
 * The workspace DTO carries no kind, no uptime, no workspace head, and no
 * ahead/behind (plue#446), and neither does the card — `bookmarkHead` is the
 * TARGET BOOKMARK's head from the bookmarks call, labeled as such, never the
 * workspace's own. The Files and Services facets have no routes (plue#449)
 * and render empty. Every act refuses a degraded sign-in with the enable
 * wording, and a bare act resolves its workspace from the active working
 * copy (kind "workspace"), else the single loaded one — never a guess.
 * A workspace still settling (pending, starting) is polled until it settles
 * or is gone; a 404 mid-watch refreshes the repository's list.
 */
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import {
  parseRepoSelection,
  WORKSPACE_STATUSES
} from "../AppState"
import type { Card, CloudWorkspaceInput, CloudWorkspaceRow } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export const DEGRADED_WORKSPACE_REFUSAL =
  "This Smithers Cloud sign-in can't use workspaces — sign in again to enable them."

const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

export type WorkspaceFacet = "terminal" | "files" | "services" | "snapshots"

export interface WorkspaceSeam {
  /** `workspace.list [owner/repo]`: refresh the collection and the tree; a bare call lists the per-user inventory. */
  readonly listWorkspaces: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The silent refresh (sign-in, boot): the collection and tree, no transcript line. */
  readonly refreshWorkspaces: (repo?: string) => Promise<string | void>
  /** `workspace.open [bookmark] [owner/repo]`: create-or-reuse, render the card, watch until it settles. */
  readonly openWorkspace: (bookmark?: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.view <id>`: re-read one workspace and render its card. */
  readonly viewWorkspace: (workspaceId: string) => Promise<string | void | { readonly value: string }>
  /** `workspace.terminal [workspaceId]`: open (or re-attach) the workspace's terminal tab. */
  readonly openTerminal: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly suspendWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly resumeWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly forkWorkspace: (workspaceId?: string, name?: string) => Promise<string | void | { readonly value: string }>
  readonly snapshotWorkspace: (workspaceId?: string, name?: string) => Promise<string | void | { readonly value: string }>
  readonly deleteSnapshot: (snapshotId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** A workspace created FROM a snapshot (the snapshot row's "Fork from"): POST /workspaces { snapshot_id }. */
  readonly forkFromSnapshot: (snapshotId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly templateSnapshot: (snapshotId: string, name: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly listSessions: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly destroySession: (sessionId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly deleteWorkspace: (workspaceId: string) => Promise<string | void | { readonly value: string }>
  /** The card's body tab; hidden, card-button scoped. */
  readonly setFacet: (workspaceId: string, facet: WorkspaceFacet) => Promise<string | void>
  /** Stop every watch timer. */
  readonly dispose: () => void
}

export interface WorkspaceSeamDeps {
  /** The watch and session-settle poll interval; tests inject ~0. */
  readonly pollMs?: number
}

interface SnapshotRow {
  readonly id: string
  readonly name: string
  readonly createdAt: string | null
}

interface SessionRow {
  readonly id: string
  readonly status: string
  readonly createdAt: string | null
}

/** The auxiliaries a workspace card renders beside the DTO row. */
interface CardAux {
  readonly bookmarkHead: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly snapshots: ReadonlyArray<SnapshotRow>
  readonly sessions: ReadonlyArray<SessionRow>
  readonly facet?: WorkspaceFacet | undefined
  /** The attached session; an explicit null override detaches. */
  readonly terminalSessionId?: string | null | undefined
  readonly error?: string | undefined
}

const UNSETTLED: ReadonlySet<string> = new Set(["pending", "starting"])

/** The statuses plue's workspace sessions move through. */
const SESSION_LIVE = "running"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** How long a new terminal session may take to reach running before the honest refusal. */
const SESSION_SETTLE_ATTEMPTS = 30

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The list a user-scoped route answers: a bare array, or one under a named key. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  return []
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const isWorkspaceStatus = (value: unknown): value is CloudWorkspaceInput["status"] =>
  typeof value === "string" && (WORKSPACE_STATUSES as ReadonlyArray<string>).includes(value)

/** One workspace row off the wire; malformed rows drop. */
const parseWorkspaceWire = (value: unknown, fallbackRepo?: string): CloudWorkspaceInput | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const repoId = str(value.repo_full_name) ?? fallbackRepo ?? null
  const name = str(value.name) ?? str(value.slug)
  if (id === null || repoId === null || name === null || !isWorkspaceStatus(value.status)) return null
  return {
    id,
    repoId,
    name,
    targetBookmark: textOrNull(value.target_bookmark),
    status: value.status,
    provisioningStage: textOrNull(value.provisioning_stage),
    suspendedAt: textOrNull(value.suspended_at),
    createdAt: textOrNull(value.created_at)
  }
}

/** One bookmark row off the wire; malformed rows drop. */
const parseBookmark = (value: unknown): { readonly name: string; readonly changeId: string | null; readonly commitId: string | null } | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null
  return {
    name: value.name,
    changeId: typeof value.target_change_id === "string" ? value.target_change_id : null,
    commitId: typeof value.target_commit_id === "string" ? value.target_commit_id : null
  }
}

/** One snapshot row off the wire; malformed rows drop. */
const parseSnapshot = (value: unknown): SnapshotRow | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const name = str(value.name)
  if (id === null || name === null) return null
  return { id, name, createdAt: textOrNull(value.created_at) }
}

/** One session row off the wire; malformed rows drop. */
const parseSession = (value: unknown): (SessionRow & { readonly workspaceId: string | null }) | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const status = str(value.status)
  if (id === null || status === null) return null
  return { id, status, createdAt: textOrNull(value.created_at), workspaceId: textOrNull(value.workspace_id) }
}

const cardIdOf = (workspaceId: string): string => `workspace-${workspaceId}`

const splitRepo = (repoId: string): { readonly owner: string; readonly name: string } => {
  const [owner = "", name = ""] = repoId.split("/")
  return { owner, name }
}

export const createWorkspaceSeam = (ctx: SeamContext, deps: WorkspaceSeamDeps = {}): WorkspaceSeam => {
  const pollMs = deps.pollMs ?? 5_000
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  const repoPath = (repoId: string, rest: string): string => {
    const { owner, name } = splitRepo(repoId)
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`
  }

  const timers = new Set<ReturnType<typeof setTimeout>>()
  const watching = new Set<string>()

  const after = (ms: number, work: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      work()
    }, ms)
    timers.add(timer)
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => after(ms, resolve))

  const dispose = (): void => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    watching.clear()
  }

  /*
   * The two gates every workspace act passes: a definitive signed-in answer,
   * and the scope set — the legacy (degraded) token reads but never acts.
   */
  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
    if (session.scopes === "degraded") return DEGRADED_WORKSPACE_REFUSAL
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
    method: "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ readonly body: unknown } | { readonly error: string }> => {
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
    return { body: await response.json().catch(() => null) }
  }

  /*
   * The workspace a bare act means: an explicit id (looked up locally — the
   * id alone cannot route without its repository), else the active working
   * copy when it is a workspace, else the single loaded workspace. Never a
   * guess.
   */
  const resolveWorkspace = (
    workspaceId?: string
  ): { readonly workspace: CloudWorkspaceRow } | { readonly error: string } => {
    const { cloudWorkspaces, workingCopies } = ctx.store.collections
    if (workspaceId !== undefined && workspaceId !== "") {
      const row = cloudWorkspaces.get(workspaceId)
      return row === undefined
        ? { error: `Workspace ${workspaceId} is not loaded — /workspace.list refreshes the inventory` }
        : { workspace: row }
    }
    const key = ctx.store.session().activeRepoKey ?? null
    const selection = key === null ? null : parseRepoSelection(key)
    if (selection !== null && "repoId" in selection && selection.copyId !== undefined) {
      const copy = workingCopies.get(selection.copyId)
      if (copy?.kind === "workspace" && copy.workspaceId !== undefined) {
        const row = cloudWorkspaces.get(copy.workspaceId)
        if (row !== undefined) return { workspace: row }
      }
    }
    const all = [...cloudWorkspaces.values()]
    if (all.length === 1) return { workspace: all[0]! }
    if (all.length === 0) {
      return { error: "No cloud workspace is loaded — /workspace.open creates one, /workspace.list refreshes" }
    }
    return { error: `Several workspaces are loaded (${all.map((row) => row.id).join(", ")}) — name a workspace id` }
  }

  /* The repository a snapshot or session act routes through. */
  const resolveRepo = (
    workspaceId?: string
  ): { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } => {
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved
    return { repo: resolved.workspace.repoId, workspaceId: resolved.workspace.id }
  }

  /* ---- the auxiliaries: absent answers, never inventions ---- */

  const loadBookmarkHead = async (
    repoId: string,
    bookmark: string | null
  ): Promise<{ readonly changeId: string | null; readonly commitId: string | null } | null> => {
    if (bookmark === null) return null
    const answer = await getJson(repoPath(repoId, "/bookmarks"))
    if ("error" in answer) return null
    const found = arrayOf(answer.body, "bookmarks")
      .flatMap((entry) => {
        const parsed = parseBookmark(entry)
        return parsed === null ? [] : [parsed]
      })
      .find((entry) => entry.name === bookmark)
    return found === undefined ? null : { changeId: found.changeId, commitId: found.commitId }
  }

  /** The repository's snapshot/template list; null = unread (an absent answer, not a fact). */
  const loadSnapshots = async (repoId: string): Promise<ReadonlyArray<SnapshotRow> | null> => {
    const answer = await getJson(repoPath(repoId, "/workspace-snapshots"))
    if ("error" in answer) return null
    return arrayOf(answer.body, "snapshots").flatMap((entry) => {
      const parsed = parseSnapshot(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /** One workspace's sessions; null = unread. */
  const loadSessions = async (repoId: string, workspaceId: string): Promise<ReadonlyArray<SessionRow> | null> => {
    const answer = await getJson(repoPath(repoId, "/workspace/sessions"))
    if ("error" in answer) return null
    return arrayOf(answer.body, "sessions").flatMap((entry) => {
      const parsed = parseSession(entry)
      return parsed === null || (parsed.workspaceId !== null && parsed.workspaceId !== workspaceId) ? [] : [parsed]
    })
  }

  /* ---- the card ---- */

  /*
   * Render one workspace's card: the DTO row plus the auxiliaries. An
   * override wins; otherwise the existing card's value stands, so a status
   * poll never blanks the snapshots the open loaded.
   */
  const renderWorkspace = (workspace: CloudWorkspaceInput, overrides: Partial<CardAux> = {}): void => {
    const id = cardIdOf(workspace.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "workspace" ? existing.payload : undefined
    const payload = {
      workspaceId: workspace.id,
      repo: workspace.repoId,
      name: workspace.name,
      targetBookmark: workspace.targetBookmark,
      status: workspace.status,
      provisioningStage: workspace.provisioningStage,
      suspendedAt: workspace.suspendedAt,
      bookmarkHead: overrides.bookmarkHead !== undefined ? overrides.bookmarkHead : prior?.bookmarkHead ?? null,
      snapshots: overrides.snapshots !== undefined ? [...overrides.snapshots] : prior?.snapshots ?? [],
      sessions: overrides.sessions !== undefined ? [...overrides.sessions] : prior?.sessions ?? [],
      ...(overrides.facet !== undefined
        ? { facet: overrides.facet }
        : prior?.facet !== undefined ? { facet: prior.facet } : {}),
      ...(overrides.terminalSessionId !== undefined
        ? overrides.terminalSessionId === null ? {} : { terminalSessionId: overrides.terminalSessionId }
        : prior?.terminalSessionId !== undefined ? { terminalSessionId: prior.terminalSessionId } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {})
    }
    const card: Card = {
      id,
      kind: "workspace",
      title: `${workspace.name} · ${workspace.repoId}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /** The failure side of an act: the refusal rides the card too, so it stays visible. */
  const failOnCard = (workspace: CloudWorkspaceInput, error: string): string => {
    renderWorkspace(workspace, { error })
    return error
  }

  /* ---- the list load (listWorkspaces, delete's aftermath, a 404 mid-watch) ---- */

  const loadList = async (repo?: string): Promise<ReadonlyArray<CloudWorkspaceInput> | string> => {
    const answer = await getJson(repo === undefined ? "/user/workspaces" : repoPath(repo, "/workspaces"))
    if ("error" in answer) return answer.error
    const workspaces = arrayOf(answer.body, "workspaces").flatMap((entry) => {
      const parsed = parseWorkspaceWire(entry, repo)
      return parsed === null ? [] : [parsed]
    })
    ctx.dispatch({
      type: "workspaces.loaded",
      actor: "system",
      workspaces,
      ...(repo === undefined ? {} : { repoId: repo })
    })
    return workspaces
  }

  /* ---- the settle watch ---- */

  /*
   * Poll one settling workspace until it leaves pending/starting (or is
   * gone). A failed poll is not a fact — the watch simply tries again; a 404
   * IS a fact, and the honest answer is to re-read the repository's list.
   */
  const poll = async (workspaceId: string): Promise<void> => {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined) {
      watching.delete(workspaceId)
      return
    }
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(row.repoId, `/workspaces/${encodeURIComponent(workspaceId)}`)))
    } catch {
      after(pollMs, () => void poll(workspaceId))
      return
    }
    if (response.status === 404) {
      watching.delete(workspaceId)
      await loadList(row.repoId)
      return
    }
    if (response.ok) {
      const parsed = parseWorkspaceWire(await response.json().catch(() => null), row.repoId)
      if (parsed !== null) {
        ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: parsed })
        renderWorkspace(parsed)
        if (!UNSETTLED.has(parsed.status)) {
          watching.delete(workspaceId)
          return
        }
      }
    }
    after(pollMs, () => void poll(workspaceId))
  }

  const watch = (workspaceId: string): void => {
    if (watching.has(workspaceId)) return
    watching.add(workspaceId)
    void poll(workspaceId)
  }

  /* ---- the acts ---- */

  const refreshWorkspaces: WorkspaceSeam["refreshWorkspaces"] = async (repo) => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return
    const loaded = await loadList(repo === undefined || repo === "" ? undefined : repo)
    return typeof loaded === "string" ? loaded : undefined
  }

  const listWorkspaces: WorkspaceSeam["listWorkspaces"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = repo === undefined || repo === "" ? undefined : resolveTargetRepo(ctx.store, repo)
    if (target !== undefined && "error" in target) return target.error
    const scope = target !== undefined && "repo" in target ? target.repo : undefined
    const loaded = await loadList(scope)
    if (typeof loaded === "string") return loaded
    const listing = loaded.length === 0
      ? scope === undefined
        ? "No cloud workspaces."
        : `No cloud workspaces on ${scope}.`
      : loaded
        .map((workspace) =>
          `${workspace.name} (${workspace.id}) · ${workspace.status} · ${workspace.repoId}${
            workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
          }`)
        .join("\n")
    ctx.dispatch({ type: "message.appended", actor: "system", text: listing })
    return { value: listing }
  }

  const openWorkspace: WorkspaceSeam["openWorkspace"] = async (bookmark, repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /*
     * The source bookmark: the explicit one, else the repository's head
     * bookmark (the same default the create route applies). An unnamed
     * source is omitted, never invented.
     */
    const repoRow = ctx.store.collections.repositories.get(target.repo)
    const source = bookmark === undefined || bookmark === "" ? repoRow?.head?.bookmark ?? undefined : bookmark
    const created = await sendJson("POST", repoPath(target.repo, "/workspaces"), {
      ...(source === undefined ? {} : { source_bookmark: source })
    })
    if ("error" in created) return created.error
    const workspace = parseWorkspaceWire(created.body, target.repo)
    if (workspace === null) return `Smithers Cloud's answer for the new workspace on ${target.repo} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
    if (UNSETTLED.has(workspace.status)) watch(workspace.id)
    const [bookmarkHead, snapshots, sessions] = await Promise.all([
      loadBookmarkHead(workspace.repoId, workspace.targetBookmark),
      loadSnapshots(workspace.repoId),
      loadSessions(workspace.repoId, workspace.id)
    ])
    renderWorkspace(workspace, {
      bookmarkHead,
      ...(snapshots === null ? {} : { snapshots }),
      ...(sessions === null ? {} : { sessions })
    })
    return {
      value: `Workspace "${workspace.name}" (${workspace.id}) is ${workspace.status} on ${workspace.repoId}${
        workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
      } — the card tracks it.`
    }
  }

  const viewWorkspace: WorkspaceSeam["viewWorkspace"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if ("error" in answer) return failOnCard(workspace, answer.error)
    const fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) return `Smithers Cloud's answer for workspace ${workspace.id} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    const [bookmarkHead, snapshots, sessions] = await Promise.all([
      loadBookmarkHead(fresh.repoId, fresh.targetBookmark),
      loadSnapshots(fresh.repoId),
      loadSessions(fresh.repoId, fresh.id)
    ])
    renderWorkspace(fresh, {
      bookmarkHead,
      ...(snapshots === null ? {} : { snapshots }),
      ...(sessions === null ? {} : { sessions })
    })
    return { value: `Workspace "${fresh.name}" (${fresh.id}) is ${fresh.status} — the card is current.` }
  }

  /* Suspend and resume share everything but the verb. */
  const transitionWorkspace = async (
    verb: "suspend" | "resume",
    workspaceId?: string
  ): Promise<string | void | { readonly value: string }> => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/${verb}`))
    if ("error" in answer) return failOnCard(workspace, answer.error)
    /*
     * The act's body is the updated workspace when plue writes one; when it
     * does not, the truth is a re-read, never an assumed status.
     */
    let fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) {
      const reread = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
      if ("error" in reread) {
        await loadList(workspace.repoId)
        return `Workspace "${workspace.name}" (${workspace.id}) ${verb}ed, but its new state could not be read — the list was refreshed.`
      }
      fresh = parseWorkspaceWire(reread.body, workspace.repoId)
      if (fresh === null) {
        await loadList(workspace.repoId)
        return `Workspace "${workspace.name}" (${workspace.id}) ${verb}ed, but its answer was malformed — the list was refreshed.`
      }
    }
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    renderWorkspace(fresh)
    return { value: `Workspace "${fresh.name}" (${fresh.id}) is ${fresh.status}.` }
  }

  const forkWorkspace: WorkspaceSeam["forkWorkspace"] = async (workspaceId, name) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const forked = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/fork`), {
      name: name ?? ""
    })
    if ("error" in forked) return failOnCard(workspace, forked.error)
    const fork = parseWorkspaceWire(forked.body, workspace.repoId)
    if (fork === null) return `Smithers Cloud's answer for the fork of ${workspace.id} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fork })
    if (UNSETTLED.has(fork.status)) watch(fork.id)
    renderWorkspace(fork)
    return { value: `Forked "${workspace.name}" into "${fork.name}" (${fork.id}), ${fork.status} — the new card tracks it.` }
  }

  const snapshotWorkspace: WorkspaceSeam["snapshotWorkspace"] = async (workspaceId, name) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const taken = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/snapshot`), {
      name: name ?? ""
    })
    if ("error" in taken) return failOnCard(workspace, taken.error)
    const snapshot = parseSnapshot(taken.body)
    const snapshots = await loadSnapshots(workspace.repoId)
    renderWorkspace(workspace, snapshots === null
      ? snapshot === null ? {} : { snapshots: [snapshot] }
      : { snapshots })
    return {
      value: snapshot === null
        ? `Snapshot of "${workspace.name}" (${workspace.id}) taken.`
        : `Snapshot "${snapshot.name}" (${snapshot.id}) taken of "${workspace.name}" (${workspace.id}).`
    }
  }

  const deleteSnapshot: WorkspaceSeam["deleteSnapshot"] = async (snapshotId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const deleted = await sendJson(
      "DELETE",
      repoPath(resolved.repo, `/workspace-snapshots/${encodeURIComponent(snapshotId)}`)
    )
    if ("error" in deleted) return deleted.error
    const snapshots = await loadSnapshots(resolved.repo)
    for (const row of ctx.store.collections.cloudWorkspaces.values()) {
      if (row.repoId !== resolved.repo) continue
      /*
       * The workspace the act resolved renders (creating its card — the
       * user just acted on it); the others only refresh a card already in
       * the transcript.
       */
      if (row.id !== resolved.workspaceId && ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
      renderWorkspace(row, snapshots === null ? {} : { snapshots })
    }
    return { value: `Snapshot ${snapshotId} is deleted.` }
  }

  const forkFromSnapshot: WorkspaceSeam["forkFromSnapshot"] = async (snapshotId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const created = await sendJson("POST", repoPath(resolved.repo, "/workspaces"), { snapshot_id: snapshotId })
    if ("error" in created) return created.error
    const workspace = parseWorkspaceWire(created.body, resolved.repo)
    if (workspace === null) return `Smithers Cloud's answer for the workspace from snapshot ${snapshotId} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
    if (UNSETTLED.has(workspace.status)) watch(workspace.id)
    renderWorkspace(workspace)
    return {
      value: `Workspace "${workspace.name}" (${workspace.id}) is ${workspace.status} from snapshot ${snapshotId} — the card tracks it.`
    }
  }

  const templateSnapshot: WorkspaceSeam["templateSnapshot"] = async (snapshotId, name, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const source = await getJson(repoPath(resolved.repo, `/workspace-snapshots/${encodeURIComponent(snapshotId)}`))
    if ("error" in source) return source.error
    const sourceWorkspaceId = isRecord(source.body) ? textOrNull(source.body.workspace_id) : null
    if (sourceWorkspaceId === null) return `Smithers Cloud's answer for snapshot ${snapshotId} named no workspace.`
    const created = await sendJson("POST", repoPath(resolved.repo, "/workspace-snapshots"), {
      workspace_id: sourceWorkspaceId,
      name
    })
    if ("error" in created) return created.error
    const template = parseSnapshot(created.body)
    const snapshots = await loadSnapshots(resolved.repo)
    for (const row of ctx.store.collections.cloudWorkspaces.values()) {
      if (row.repoId !== resolved.repo) continue
      if (row.id !== resolved.workspaceId && ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
      renderWorkspace(row, snapshots === null ? {} : { snapshots })
    }
    return {
      value: template === null
        ? `Template "${name}" created from snapshot ${snapshotId}.`
        : `Template "${template.name}" (${template.id}) created from snapshot ${snapshotId}.`
    }
  }

  const listSessions: WorkspaceSeam["listSessions"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    if (sessions === null) return `The sessions of workspace ${workspace.id} couldn't be read right now.`
    renderWorkspace(workspace, { sessions })
    return {
      value: sessions.length === 0
        ? `Workspace "${workspace.name}" (${workspace.id}) has no sessions.`
        : `Workspace "${workspace.name}" (${workspace.id}) sessions: ${
          sessions.map((session) => `${session.id} (${session.status})`).join(", ")
        }.`
    }
  }

  const destroySession: WorkspaceSeam["destroySession"] = async (sessionId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const destroyed = await sendJson(
      "POST",
      repoPath(resolved.repo, `/workspace/sessions/${encodeURIComponent(sessionId)}/destroy`)
    )
    if ("error" in destroyed) return destroyed.error
    /*
     * A card whose terminal pointed at the destroyed session stops pointing:
     * the facet re-offers to open one rather than claim a dead attachment.
     */
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "workspace" || card.payload.repo !== resolved.repo) continue
      const row = ctx.store.collections.cloudWorkspaces.get(card.payload.workspaceId)
      if (row === undefined) continue
      const sessions = await loadSessions(resolved.repo, row.id)
      renderWorkspace(row, {
        ...(sessions === null ? {} : { sessions }),
        ...(card.payload.terminalSessionId === sessionId ? { terminalSessionId: null } : {})
      })
    }
    return { value: `Session ${sessionId} is destroyed.` }
  }

  const deleteWorkspace: WorkspaceSeam["deleteWorkspace"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const deleted = await sendJson("DELETE", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if ("error" in deleted) return failOnCard(workspace, deleted.error)
    /*
     * Gone is a fact: the card leaves the transcript, the list refresh
     * removes the collection row and its tree copy.
     */
    ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: cardIdOf(workspace.id) })
    const loaded = await loadList(workspace.repoId)
    if (typeof loaded === "string") return loaded
    return { value: `Workspace "${workspace.name}" (${workspace.id}) is deleted.` }
  }

  const setFacet: WorkspaceSeam["setFacet"] = async (workspaceId, facet) => {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined) return `Workspace ${workspaceId} is not loaded — /workspace.list refreshes the inventory`
    if (facet === "snapshots") {
      const snapshots = await loadSnapshots(row.repoId)
      renderWorkspace(row, { facet, ...(snapshots === null ? {} : { snapshots }) })
      return
    }
    if (facet === "terminal") {
      const sessions = await loadSessions(row.repoId, row.id)
      renderWorkspace(row, { facet, ...(sessions === null ? {} : { sessions }) })
      return
    }
    renderWorkspace(row, { facet })
  }

  const openTerminal: WorkspaceSeam["openTerminal"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    if (workspace.status !== "running") {
      return failOnCard(
        workspace,
        `"${workspace.name}" (${workspace.id}) is ${workspace.status}, not running — ${
          workspace.status === "suspended" || workspace.status === "stopped"
            ? "/workspace.resume it first"
            : "wait for it to settle (the card tracks it)"
        }.`
      )
    }
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const attached = card?.kind === "workspace" ? card.payload.terminalSessionId : undefined
    const openTab = (sessionId: string): void => {
      const existing = ctx.store.collections.tabs.get(sessionId)
      if (existing !== undefined) {
        ctx.dispatch({ type: "tab.selected", actor: ctx.actor(), id: existing.id })
        return
      }
      ctx.dispatch({
        type: "tab.opened",
        actor: ctx.actor(),
        tab: {
          id: sessionId,
          kind: "terminal",
          title: `Terminal · ${workspace.name}`,
          sessionId,
          workspaceId: workspace.id,
          repo: workspace.repoId,
          repoKey: `workspace:${workspace.id}`
        }
      })
    }
    if (attached !== undefined && attached !== "") {
      const session = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(attached)}`))
      const parsed = "error" in session ? null : parseSession(session.body)
      if (parsed !== null && parsed.status === SESSION_LIVE) {
        openTab(attached)
        renderWorkspace(workspace, { facet: "terminal" })
        return { value: `Re-attached to session ${attached} of "${workspace.name}" (${workspace.id}).` }
      }
    }
    const created = await sendJson("POST", repoPath(workspace.repoId, "/workspace/sessions"), {
      workspace_id: workspace.id,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    })
    if ("error" in created) return failOnCard(workspace, created.error)
    const session = parseSession(created.body)
    if (session === null) return `Smithers Cloud's answer for the new session on ${workspace.id} was malformed.`
    /*
     * A fresh session may still be pending: poll it until it runs, or the
     * honest refusal names what it settled as.
     */
    let live = session
    for (let attempt = 0; live.status !== SESSION_LIVE && attempt < SESSION_SETTLE_ATTEMPTS; attempt += 1) {
      if (live.status === "failed" || live.status === "stopped") break
      await sleep(pollMs)
      const answer = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(session.id)}`))
      const parsed = "error" in answer ? null : parseSession(answer.body)
      if (parsed === null) break
      live = parsed
    }
    if (live.status !== SESSION_LIVE) {
      return failOnCard(workspace, `Session ${live.id} of "${workspace.name}" settled as ${live.status}, not running.`)
    }
    openTab(live.id)
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    renderWorkspace(workspace, {
      facet: "terminal",
      terminalSessionId: live.id,
      ...(sessions === null ? {} : { sessions })
    })
    return { value: `Terminal open on session ${live.id} of "${workspace.name}" (${workspace.id}).` }
  }

  return {
    listWorkspaces,
    refreshWorkspaces,
    openWorkspace,
    viewWorkspace,
    openTerminal,
    suspendWorkspace: (workspaceId) => transitionWorkspace("suspend", workspaceId),
    resumeWorkspace: (workspaceId) => transitionWorkspace("resume", workspaceId),
    forkWorkspace,
    snapshotWorkspace,
    deleteSnapshot,
    forkFromSnapshot,
    templateSnapshot,
    listSessions,
    destroySession,
    deleteWorkspace,
    setFacet,
    dispose
  }
}
