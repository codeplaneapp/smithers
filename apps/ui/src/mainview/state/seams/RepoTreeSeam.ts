/*
 * The sidebar's file tree seam (docs/workbench-lanes/sidebar-tree.md): one
 * directory of a LOCAL working copy, read through the same route the files
 * flows use (`POST /api/repo/files { repoId, path }`, FilesSeam's
 * requestLocalFiles) and written to the `app-repo-tree` row for that
 * directory. The row is what the sidebar renders: `loaded` with exactly the
 * entries the route returned (no filtering, nothing invented), or `failed`
 * with the route's error text verbatim, shown in place. Never throws.
 */
import type { Repo } from "@smthrs/rpc/LocalApp"
import { requestLocalFiles } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"

export interface RepoTreeSeam {
  /** Load one directory (`""` = the root) of a working copy into its tree row. */
  readonly loadDirectory: (copyId: string, path: string) => Promise<void>
}

/** A relative directory path with no leading, trailing, or doubled slashes. */
export const normalizeTreePath = (path: string): string => path.split("/").filter((segment) => segment !== "").join("/")

/*
 * The open repository behind a working copy. A local copy's id is its pin
 * key (`local:<path>`), and the server mints a fresh opaque `repoId` per
 * open, so the copy resolves to the repos row whose path it names. A copy
 * the server does not hold this launch answers the same honest string the
 * files flows answer for a pinned-but-unopened checkout.
 */
export const openRepoOfCopy = (
  store: SeamContext["store"],
  copyId: string
): { readonly repo: Repo } | { readonly error: string } => {
  const copy = store.collections.workingCopies.get(copyId)
  const path = copy?.path ?? (copyId.startsWith("local:") ? copyId.slice("local:".length) : undefined)
  const name = store.collections.pinnedRepos.get(copyId)?.name ?? copy?.label ?? copyId
  if (path === undefined) return { error: `${name} is a cloud workspace; only a checkout on this machine lists its files here.` }
  const repo = [...store.collections.repos.values()].find((candidate) => candidate.path === path)
  if (repo === undefined) return { error: `${name} is pinned but not open on this machine — open it with /repo.open, then retry.` }
  return { repo }
}

export const createRepoTreeSeam = (ctx: SeamContext): RepoTreeSeam => {
  const failed = (copyId: string, path: string, error: string): void => {
    ctx.dispatch({ type: "repo-tree.failed", actor: "system", copyId, path, error })
  }
  const loadDirectory: RepoTreeSeam["loadDirectory"] = async (copyId, pathArg) => {
    const path = normalizeTreePath(pathArg)
    const resolved = openRepoOfCopy(ctx.store, copyId)
    if ("error" in resolved) {
      failed(copyId, path, resolved.error)
      return
    }
    const label = path === "" ? "/" : path
    const answer = await requestLocalFiles(ctx, resolved.repo, path, label, "list")
    if ("error" in answer) {
      failed(copyId, path, answer.error)
      return
    }
    if (answer.body.kind === "file") {
      failed(copyId, path, `${label} in ${resolved.repo.name} is a file — run /files.read ${label} instead`)
      return
    }
    // A row the user collapsed (or unpinned) while the request was out is still the answer's home; the reducer keeps its caret.
    ctx.dispatch({
      type: "repo-tree.loaded",
      actor: "system",
      copyId,
      path,
      entries: answer.body.entries,
      truncated: answer.body.truncated === true
    })
  }
  return { loadDirectory }
}
