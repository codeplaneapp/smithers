/*
 * The one target-repo resolution rule for repo-scoped commands (issues, PRs,
 * environment, import), following the flow.create precedent (Wave 12 §2):
 * an explicit trailing `owner/repo` token wins; otherwise a single watched
 * repository is the target; otherwise the answer is an honest error naming the
 * choice — the target is a genuine user decision, never a guess.
 */
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
  const watched = store.collections.watchedRepos.get("watched")
  const selected = watched?.selected ?? null
  if (selected === null || selected.length === 0) {
    return { error: "No repository is watched yet — run /repos.watch first, or name one as owner/repo" }
  }
  if (selected.length === 1) return { repo: selected[0] as string }
  return {
    error: `Several repositories are watched (${selected.join(", ")}) — name one as owner/repo`
  }
}
