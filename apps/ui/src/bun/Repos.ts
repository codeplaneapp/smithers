/*
 * Open repositories and Smithers workspace detection (LOCAL-APP.md,
 * "Repository detection"). A repository is a directory on disk; its id is a
 * short hash of the absolute path so the same folder always maps to the same
 * record. Detection reads only the files the rule names; git facts come from
 * `git` run in the repository.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import type { Repo, RepoWorkspace } from "smithers-shared/LocalApp"
import { readRepoPlugin } from "./RepoPlugin"
import { currentSandboxHost, probePolicy, wrapSandbox } from "./Sandbox"

export type SmithersDetection = Repo["smithers"]

const WORKSPACE_FILES = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts"] as const
const ROOT_DECLARATION_FILES = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts", "BUILD.ts"] as const
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".flows", "dist", "build"])
/** The workspace discovery walk skips the manifest dir too, so `.smithers` itself is never reported as a workspace. */
const WORKSPACE_SKIPPED_DIRS = new Set([...SKIPPED_DIRS, "target", ".smithers"])
/** Child workspaces are discovered at depth 1 and 2 below the root. */
const MAX_WORKSPACE_DEPTH = 2
/** Deep enough for any package layout; keeps a runaway tree from stalling the open. */
const MAX_WALK_DEPTH = 12

/** `from "@smthrs/...` or `from "smthrs...`, single or double quotes. */
export const IMPORTS_SMTHRS = /from\s+["'](?:@smthrs\/|smthrs)/

export const repoId = (absolutePath: string): string =>
  createHash("sha256").update(absolutePath).digest("hex").slice(0, 12)

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const importsSmthrs = (path: string): boolean => {
  try {
    return IMPORTS_SMTHRS.test(readFileSync(path, "utf8"))
  } catch {
    return false
  }
}

/** Every PACKAGE.ts below the root, skipping the vendored and generated trees. */
const packageFiles = (root: string): Array<string> => {
  const found: Array<string> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return
    let entries: Array<import("node:fs").Dirent>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path, depth + 1)
      } else if (entry.name === "PACKAGE.ts" && entry.isFile()) {
        found.push(path)
      }
    }
  }
  walk(root, 0)
  return found.sort()
}

/** The directory's own workspace file, or null. */
const workspaceFileOf = (dir: string): string | null => WORKSPACE_FILES.find((file) => isFile(join(dir, file))) ?? null

const childDirs = (dir: string): Array<string> => {
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !WORKSPACE_SKIPPED_DIRS.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * The root and child workspaces (LOCAL-APP.md "Repository detection"):
 * every directory up to two levels deep that carries WORKSPACE.ts or
 * .smithers/WORKSPACE.ts. The root is "."; a child's title is its last
 * segment.
 */
export const discoverWorkspaces = (root: string): Array<RepoWorkspace> => {
  const found: Array<RepoWorkspace> = []
  if (workspaceFileOf(root) !== null) found.push({ path: ".", title: basename(root) })
  let frontier = childDirs(root)
  for (let depth = 1; depth <= MAX_WORKSPACE_DEPTH && frontier.length > 0; depth += 1) {
    const next: Array<string> = []
    for (const dir of frontier) {
      if (workspaceFileOf(dir) !== null) found.push({ path: relative(root, dir), title: basename(dir) })
      if (depth < MAX_WORKSPACE_DEPTH) next.push(...childDirs(dir))
    }
    frontier = next
  }
  return found
}

/**
 * The detection verdict for a root directory. Detected iff the workspace
 * list is nonempty; `reason` names the negative verdict.
 */
export const detectSmithers = (root: string): SmithersDetection => {
  const workspaces = discoverWorkspaces(root)
  if (workspaces.length === 0) {
    return { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces }
  }
  const candidates = [
    ...ROOT_DECLARATION_FILES.map((file) => join(root, file)).filter(isFile),
    ...packageFiles(root)
  ]
  const declarationFiles = [...new Set(candidates.filter(importsSmthrs).map((file) => relative(root, file)))]
  return {
    detected: true,
    workspaceFile: workspaceFileOf(root),
    declarationFiles,
    reason: `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} detected`,
    workspaces
  }
}

/** Seatbelt matches resolved paths, so the scratch dir the probe may write is canonicalised. */
const probeTmpdir = (): string => {
  try {
    return realpathSync(tmpdir())
  } catch {
    return tmpdir()
  }
}

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  try {
    // Read-only probe: no network, writes confined to scratch (LOCAL-APP.md, "Sandbox").
    const wrapped = wrapSandbox(["git", "-C", cwd, ...args], probePolicy({ tmpdir: probeTmpdir() }), currentSandboxHost())
    const child = Bun.spawn([...wrapped.argv], {
      env: { ...(Bun.env as Record<string, string | undefined>), GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore"
    })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    const value = stdout.trim()
    return code === 0 && value !== "" ? value : null
  } catch {
    return null
  }
}

/** `owner/name` from a GitHub-style remote (https or scp syntax), else null. */
export const ownerNameOf = (remote: string | null): string | null => {
  if (remote === null) return null
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (match === null) return null
  return `${match[1]}/${match[2]}`
}

export type InspectRepoResult =
  | { readonly status: "ok"; readonly repo: Repo }
  | { readonly status: "error"; readonly code: "not_a_directory" | "invalid_path"; readonly message: string }

/** The Repo record for a path: realpath, git facts, and the detection verdict. */
export const inspectRepo = async (path: string): Promise<InspectRepoResult> => {
  let root: string
  try {
    root = await realpath(path)
    if (!(await stat(root)).isDirectory()) {
      return { status: "error", code: "not_a_directory", message: `${path} is not a directory.` }
    }
  } catch {
    return { status: "error", code: "invalid_path", message: `${path} does not exist or cannot be read.` }
  }
  const inside = (await git(root, ["rev-parse", "--is-inside-work-tree"])) === "true"
  const [branch, remote] = inside
    ? await Promise.all([git(root, ["branch", "--show-current"]), git(root, ["remote", "get-url", "origin"])])
    : [null, null]
  const smithers = detectSmithers(root)
  const manifest = readRepoPlugin(root, smithers.workspaces.map((workspace) => workspace.path))
  return {
    status: "ok",
    repo: {
      id: repoId(root),
      path: root,
      name: ownerNameOf(remote) ?? basename(root),
      git: inside ? { branch, remote } : null,
      warnings: manifest.warnings,
      ...(manifest.plugin === undefined ? {} : { plugin: manifest.plugin }),
      smithers
    }
  }
}

export interface RepoStore {
  readonly open: (path: string) => Promise<InspectRepoResult>
  readonly close: (repoId: string) => boolean
  readonly get: (repoId: string) => Repo | undefined
  readonly list: () => ReadonlyArray<Repo>
}

/** The open repositories, in open order; reopening a path refreshes its record in place. */
export const createRepoStore = (): RepoStore => {
  const repos = new Map<string, Repo>()
  return {
    open: async (path) => {
      const result = await inspectRepo(path)
      if (result.status === "ok") repos.set(result.repo.id, result.repo)
      return result
    },
    close: (id) => repos.delete(id),
    get: (id) => repos.get(id),
    list: () => [...repos.values()]
  }
}
