/*
 * The one target-repo resolution rule for repo-scoped commands (issues, PRs,
 * environment, import), following the flow.create precedent (Wave 12 §2):
 * an explicit trailing `owner/repo` token wins; otherwise the active row
 * (lane piper: the active working copy's repository, else the selected
 * repository's head); otherwise the answer is an honest error naming the
 * choice — the target is a genuine user decision, never a guess.
 */
import type { Repo } from "@smthrs/rpc/LocalApp"
import { activeRepoOf, parseRepoSelection } from "./AppState"
import type { CloudRepository } from "./AppState"
import type { AppStore } from "./AppStore"

const REPO_TOKEN = /^[\w.-]+\/[\w.-]+$/

/** Splits a trailing `owner/repo` token off a command's argument text. */
export const splitTrailingRepo = (
  args: string | undefined
): { readonly rest: string; readonly repo?: string } => {
  const text = (args ?? "").trim()
  if (text === "") return { rest: "" }
  const parts = text.split(/\s+/)
  const last = parts[parts.length - 1] ?? ""
  if (parts.length > 0 && REPO_TOKEN.test(last)) {
    return { rest: parts.slice(0, -1).join(" "), repo: last }
  }
  return { rest: text }
}

/**
 * The `owner/name` the active selection names: the selected repository, or
 * the repository behind the selected working copy. Null when nothing is
 * selected or the selection is a local-only checkout.
 */
export const activeRepositoryId = (store: AppStore): string | null => {
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection === null) return null
  if ("repoId" in selection) return selection.repoId
  const copy = store.collections.workingCopies.get(selection.localCopyId)
  return copy !== undefined && REPO_TOKEN.test(copy.repoId) ? copy.repoId : null
}

/**
 * The `owner/name` the selection names when the public catalog supplied it
 * (apps/server/PUBLIC-REPOSITORIES.md): the one repository a signed-out
 * visitor reads and talks about. Null for any other selection.
 */
export const catalogRepositoryOf = (
  activeRepoKey: string | null | undefined,
  repositories: Iterable<Pick<CloudRepository, "id" | "catalog">>
): string | null => {
  const selection = activeRepoKey === undefined || activeRepoKey === null ? null : parseRepoSelection(activeRepoKey)
  if (selection === null || !("repoId" in selection)) return null
  for (const repository of repositories) {
    if (repository.id === selection.repoId) return repository.catalog === true ? selection.repoId : null
  }
  return null
}

/** {@link catalogRepositoryOf} read from the store. */
export const activeCatalogRepositoryId = (store: AppStore): string | null =>
  catalogRepositoryOf(store.session().activeRepoKey, store.collections.repositories.values())

/** The resolved target repository, or the honest error stating the choice. */
export const resolveTargetRepo = (
  store: AppStore,
  explicit: string | undefined
): { readonly repo: string } | { readonly error: string } => {
  if (explicit !== undefined && explicit !== "") {
    if (!REPO_TOKEN.test(explicit)) {
      return { error: `"${explicit}" is not an owner/repo name` }
    }
    return { repo: explicit }
  }
  /*
   * Lane piper: the active selection is the target — a working copy's
   * repository, the selected repository, or a local-only checkout. A
   * single loaded repository is the target when nothing is selected.
   */
  const active = activeRepositoryId(store)
  if (active !== null) return { repo: active }
  const loaded = [...store.collections.repositories.values()]
  if (loaded.length === 1) return { repo: loaded[0]!.id }
  if (loaded.length === 0) {
    return { error: "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo" }
  }
  return {
    error: `Several repositories are loaded (${loaded.map((repo) => repo.id).join(", ")}) — name one as owner/repo`
  }
}

/**
 * The open LOCAL repository a bare repo-scoped command means (files, targets,
 * graph): the active working copy when it is a checkout open here (lane
 * piper: "the active working copy if one is active, else head" — a head
 * selection has no local checkout, which is an honest error for a LOCAL
 * command). Local-only checkouts are resolved through the same working-copy
 * collection as remote-backed checkouts.
 */
export const resolveOpenRepo = (store: AppStore): { readonly repo: Repo } | { readonly error: string } => {
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection !== null) {
    const copyId = "repoId" in selection ? selection.copyId : selection.localCopyId
    if (copyId !== undefined) {
      const copy = store.collections.workingCopies.get(copyId)
      if (copy?.kind === "local" && copy.path !== undefined) {
        const open = [...store.collections.repos.values()].find((repo) => repo.path === copy.path)
        if (open !== undefined) return { repo: open }
      }
      return { error: "The active working copy is not open on this machine — open it with /repo.open first." }
    }
    if ("repoId" in selection) {
      return { error: `${selection.repoId} is selected at its head — open a local working copy with /repo.open first.` }
    }
    return { error: "Open a repository first." }
  }
  const active = activeRepoOf(store.session(), store.collections.repos.values())
  return active === undefined ? { error: "Open a repository first." } : { repo: active }
}

/** Exact Plue workspace selection for the gateway; UI frame IDs are unrelated. */
export type GatewayBinding = { readonly workspaceId?: string } | { readonly error: string }
/** Persisted provenance wins over the currently selected workspace, including legacy omission. */
export const gatewayRunContextFor = (store: AppStore, runId: string):
  { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } | undefined => {
  const trace = store.collections.cards.get(`flow-run-${runId}`)
  const authoritative = trace?.kind === "run-trace" && trace.payload.runId === runId ? trace.payload : undefined
  let found: { repo: string; workspaceId?: string } | undefined = authoritative === undefined ? undefined
    : { repo: authoritative.repo, ...(authoritative.workspaceId === undefined ? {} : { workspaceId: authoritative.workspaceId }) }
  for (const card of store.collections.cards.values()) {
    const owns = card.kind === "run-trace" ? card.payload.runId === runId
      : card.kind === "approval" ? card.payload.runId === runId
      : card.kind === "run-list" ? card.payload.runs.some((row) => row.runId === runId)
      : card.kind === "approvals-inbox" ? card.payload.approvals.some((row) => row.runId === runId) : false
    if (!owns || !("repo" in card.payload) || typeof card.payload.repo !== "string") continue
    const workspaceId = "workspaceId" in card.payload && typeof card.payload.workspaceId === "string" ? card.payload.workspaceId : undefined
    // Before ancillary cards stored bindings, even a bound run's list/approval
    // omitted this field. Only its already-recorded run card can repair that
    // omission; never infer historical ownership from the active selection.
    if (workspaceId === undefined && authoritative?.workspaceId !== undefined &&
      card.kind !== "run-trace" && card.payload.repo === authoritative.repo) continue
    if (found !== undefined && (found.repo !== card.payload.repo || found.workspaceId !== workspaceId)) {
      return { error: `The recorded run has conflicting gateway workspaces: ${found.repo}@${found.workspaceId ?? "legacy (no workspace)"} and ${card.payload.repo}@${workspaceId ?? "legacy (no workspace)"} on card ${card.id}.` }
    }
    found = { repo: card.payload.repo, ...(workspaceId === undefined ? {} : { workspaceId }) }
  }
  return found
}

export const gatewayBindingFor = (store: AppStore, repo: string, runId?: string): GatewayBinding => {
  if (runId !== undefined) {
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) {
      if ("error" in recorded) return recorded
      if (recorded.repo !== repo) return { error: "The run belongs to another repository." }
      return recorded.workspaceId === undefined ? {} : { workspaceId: recorded.workspaceId }
    }
  }
  const key = store.session().activeRepoKey
  const selection = key == null ? null : parseRepoSelection(key)
  if (selection === null || !("repoId" in selection) || selection.repoId !== repo || selection.copyId === undefined) return {}
  const copy = store.collections.workingCopies.get(selection.copyId)
  if (copy === undefined || copy.repoId !== repo) {
    return { error: "The selected working copy is no longer available for this repository." }
  }
  if (copy.kind !== "workspace") return {}
  const workspace = copy.workspaceId === undefined ? undefined : store.collections.cloudWorkspaces.get(copy.workspaceId)
  if (workspace === undefined || workspace.repoId !== repo) {
    return { error: "The selected cloud workspace is no longer available for this repository." }
  }
  return { workspaceId: workspace.id }
}
