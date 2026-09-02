/*
 * The one target-repo resolution rule for repo-scoped commands (issues, PRs,
 * environment, import), following the flow.create precedent (Wave 12 §2):
 * an explicit trailing `owner/repo` token wins; otherwise the active row
 * (lane piper: the active working copy's repository, else the selected
 * repository's head); otherwise the answer is an honest error naming the
 * choice — the target is a genuine user decision, never a guess.
 */
import type { Repo } from "smithers-shared/LocalApp"
import { activeRepoOf, parseRepoSelection } from "./AppState"
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
   * repository, the selected repository, or a legacy pin's checkout. A
   * single loaded repository is the target when nothing is selected.
   */
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection !== null) {
    if ("repoId" in selection) return { repo: selection.repoId }
    const copy = store.collections.workingCopies.get(selection.legacyCopyId)
    if (copy !== undefined && REPO_TOKEN.test(copy.repoId)) return { repo: copy.repoId }
  }
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
 * command). The legacy pin-key rule (activeRepoOf, the rule the sidebar
 * highlight, the composer's selector, and a new terminal already follow)
 * stands until every reader carries the new grammar.
 */
export const resolveOpenRepo = (store: AppStore): { readonly repo: Repo } | { readonly error: string } => {
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection !== null) {
    const copyId = "repoId" in selection ? selection.copyId : selection.legacyCopyId
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
