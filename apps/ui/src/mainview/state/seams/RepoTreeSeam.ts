/*
 * The sidebar's file tree seam (docs/workbench-lanes/sidebar-tree.md): one
 * directory of a working copy, written to the `app-repo-tree` row for that
 * directory. A LOCAL checkout reads through the same route the files flows
 * use (`POST /api/repo/files { repoId, path }`, FilesSeam's
 * requestLocalFiles). A cloud WORKSPACE copy (a box) reads through the route
 * its Files facet uses (`GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`,
 * WorkspaceSeam.loadFiles). The row is what the sidebar renders: `loaded`
 * with exactly the entries the route returned (no filtering, nothing
 * invented), or `failed` with the route's error text verbatim, shown in
 * place. Never throws.
 */
import { isRecord } from "@smthrs/canonical/Record"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { RepoTreeEntry, WorkingCopy } from "../AppState"
import { createCloudClient } from "./CloudClient"
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

/**
 * Why a box cannot list files right now, in the state the inventory holds
 * for it. `undefined` for a running box: the route is asked, and its own
 * answer stands. A `failed` box never settles (the settle watch polls only
 * pending/starting) and cannot be resumed; plue's failure_message rides on
 * the workspace row, so the card is where the reason shows.
 */
export const workspaceTreeRefusal = (copy: WorkingCopy): string | undefined => {
  if (copy.state === undefined || copy.state === "running") return undefined
  const name = `${copy.label} (${copy.workspaceId ?? copy.id})`
  if (copy.state === "failed") return `${name} is failed; the workspace card names why.`
  const remedy = copy.state === "suspended" || copy.state === "stopped"
    ? "/workspace.resume it first"
    : "wait for it to settle (the workspace card tracks it)"
  return `${name} is ${copy.state}, not running; ${remedy}.`
}

/**
 * The `/workspaces/{id}/files` path of a box, under the repository the copy
 * names (`org/repo`). The route reads a directory; the entry shape is plue's
 * WorkspaceFileEntry (`name`, `path`, `type: "dir" | "file"`, `size`).
 */
const workspaceFilesPath = (repoId: string, workspaceId: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(workspaceId)}/files`
}

/** plue's entries as tree rows: a row without a name drops, a `dir` type is a directory, anything else a file. */
const treeEntriesOf = (body: unknown): ReadonlyArray<RepoTreeEntry> => {
  const entries = isRecord(body) && Array.isArray(body.entries) ? body.entries : []
  return entries.flatMap((entry): ReadonlyArray<RepoTreeEntry> => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") return []
    return [{ name: entry.name, kind: entry.type === "dir" ? "dir" : "file" }]
  })
}

export const createRepoTreeSeam = (ctx: SeamContext): RepoTreeSeam => {
  const { get: getJson } = createCloudClient(ctx)
  const failed = (copyId: string, path: string, error: string): void => {
    ctx.dispatch({ type: "repo-tree.failed", actor: "system", copyId, path, error })
  }
  /*
   * A box's directory: refused in place while the box is not running (its
   * state sentence, nothing invented), otherwise the route's answer. The
   * Worker forwards the path with the visitor's own session, so a signed-out
   * page gets the Worker's refusal verbatim.
   */
  const loadWorkspaceDirectory = async (copy: WorkingCopy, path: string): Promise<void> => {
    const refusal = workspaceTreeRefusal(copy)
    if (refusal !== undefined) {
      failed(copy.id, path, refusal)
      return
    }
    const label = path === "" ? "/" : path
    const answer = await getJson(
      `${workspaceFilesPath(copy.repoId, copy.workspaceId ?? copy.id)}?path=${encodeURIComponent(path)}`,
      `${label} in ${copy.label}`
    )
    if ("error" in answer) {
      failed(copy.id, path, answer.error)
      return
    }
    ctx.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: copy.id, path, entries: treeEntriesOf(answer.body), truncated: false })
  }
  const loadDirectory: RepoTreeSeam["loadDirectory"] = async (copyId, pathArg) => {
    const path = normalizeTreePath(pathArg)
    const copy = ctx.store.collections.workingCopies.get(copyId)
    if (copy?.kind === "workspace") {
      await loadWorkspaceDirectory(copy, path)
      return
    }
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
