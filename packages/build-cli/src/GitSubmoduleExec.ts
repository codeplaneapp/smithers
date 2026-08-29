/**
 * Gitlink-keyed submodule planning for package-mode execution.
 *
 * The git index is the version authority. `.gitmodules` selects paths, globs
 * are expanded before execution, and populated worktrees must already match
 * their pinned gitlink commit. Checkout is required only for missing/empty
 * paths and therefore implies a network-enabled sandbox.
 *
 * @since 0.1.0
 */
import type * as GitTarget from "@smthrs/targets/GitTarget"
import * as Input from "@smthrs/targets/Input"
import { minimatch } from "minimatch"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"

/** One submodule selected and pinned by the repository index.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gitlink {
  readonly path: string
  readonly sha: string
  readonly state: "missing" | "empty" | "matching" | "mismatch"
  readonly head?: string | undefined
  readonly dirty?: boolean | undefined
}

/** The complete plan for one Git.Submodule(s) target.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly paths: ReadonlyArray<string>
  readonly gitlinks: ReadonlyArray<Gitlink>
  readonly refusal?: string | undefined
}

const configPaths = async (root: string, config: string): Promise<ReadonlyArray<string>> => {
  // `-z` separates records with NUL and the key from its value with a newline,
  // so a submodule name or path carrying whitespace still parses exactly.
  const raw = await PackageTree.runGit(root, [
    "config",
    "-z",
    "--file",
    config,
    "--get-regexp",
    "^submodule\\..*\\.path$"
  ]).catch(() => "")
  const directory = NodePath.posix.dirname(config) === "." ? "" : NodePath.posix.dirname(config)
  const paths: Array<string> = []
  for (const record of raw.split("\0")) {
    const newline = record.indexOf("\n")
    if (newline < 0) continue
    const declared = record.slice(newline + 1)
    if (declared === "") continue
    paths.push(Input.resolvePath(directory, declared))
  }
  return [...new Set(paths)].sort()
}

const pinnedSha = async (root: string, path: string): Promise<string | undefined> => {
  const raw = await PackageTree.runGit(root, ["ls-files", "--stage", "--", path]).catch(() => "")
  const match = /^160000 ([0-9a-f]{40,64}) 0\t/.exec(raw)
  return match?.[1]
}

const stateOf = async (root: string, path: string, sha: string): Promise<Gitlink> => {
  const absolute = NodePath.join(root, ...path.split("/"))
  const stats = await Fs.lstat(absolute).catch(() => undefined)
  if (stats === undefined) return { path, sha, state: "missing" }
  if (!stats.isDirectory()) return { path, sha, state: "mismatch" }
  if ((await Fs.readdir(absolute)).length === 0) return { path, sha, state: "empty" }
  const head = (await PackageTree.runGit(absolute, ["rev-parse", "HEAD"]).catch(() => "")).trim()
  const dirty = (await PackageTree.runGit(absolute, ["status", "--porcelain", "--untracked-files=all"])
    .catch(() => "unreadable")).trim() !== ""
  return head === sha && !dirty
    ? { path, sha, state: "matching", head, dirty }
    : { path, sha, state: "mismatch", head, dirty }
}

/** Resolves paths, gitlink SHAs, and current worktree state.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (
  options:
    | {
      readonly root: string
      readonly packagePath: string
      readonly rule: "Git.Submodules"
      readonly attrs: (typeof GitTarget.SubmodulesAttrs)["Type"]
    }
    | {
      readonly root: string
      readonly packagePath: string
      readonly rule: "Git.Submodule"
      readonly attrs: (typeof GitTarget.SubmoduleAttrs)["Type"]
    }
): Promise<Plan> => {
  let paths: ReadonlyArray<string>
  if (options.rule === "Git.Submodule") {
    paths = [Input.resolvePath(options.packagePath, options.attrs.path)]
  } else {
    const config = Input.resolvePath(options.packagePath, options.attrs.config.path)
    const available = await configPaths(options.root, config)
    const directory = NodePath.posix.dirname(config) === "." ? "" : NodePath.posix.dirname(config)
    const patterns = options.attrs.paths.map((path) => Input.resolvePath(directory, path))
    paths = available.filter((path) => patterns.some((pattern) => minimatch(path, pattern, { dot: true })))
    if (paths.length === 0) {
      return {
        paths,
        gitlinks: [],
        refusal: `Git.Submodules paths ${JSON.stringify(options.attrs.paths)} match no entries in ${config}`
      }
    }
  }

  const gitlinks: Array<Gitlink> = []
  for (const path of [...new Set(paths)].sort()) {
    const sha = await pinnedSha(options.root, path)
    if (sha === undefined) {
      return { paths, gitlinks, refusal: `Git submodule ${path} has no stage-0 gitlink in the repository index` }
    }
    const link = await stateOf(options.root, path, sha)
    gitlinks.push(link)
    if (link.state === "mismatch") {
      return {
        paths,
        gitlinks,
        refusal: link.head === sha && link.dirty === true
          ? `Git submodule ${path} worktree has changes relative to pinned gitlink ${sha}`
          : `Git submodule ${path} worktree HEAD ${
            link.head === "" || link.head === undefined ? "is not readable" : link.head
          } does not match pinned gitlink ${sha}`
      }
    }
  }
  return { paths: [...new Set(paths)].sort(), gitlinks }
}

/** Whether every selected checkout is populated at its pinned SHA.
 *
 * @category execution
 * @since 0.1.0
 */
export const isMaterialized = (plan: Plan): boolean => plan.gitlinks.every((link) => link.state === "matching")

/** Revalidates the selected worktrees after cache restore or checkout.
 *
 * @category execution
 * @since 0.1.0
 */
export const verify = async (root: string, plan: Plan): Promise<string | undefined> => {
  for (const link of plan.gitlinks) {
    const current = await stateOf(root, link.path, link.sha)
    if (current.state !== "matching") {
      return `Git submodule ${link.path} did not materialize pinned gitlink ${link.sha}`
    }
  }
  return undefined
}
