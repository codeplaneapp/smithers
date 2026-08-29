/**
 * Ignore-blind PACKAGE.ts / WORKSPACE.ts discovery.
 *
 * Discovery walks the filesystem from the canonical workspace root and never
 * consults git: gitignore status is irrelevant, so a gitignored or generated
 * PACKAGE.ts participates like any other. The walk prunes `.git`,
 * `node_modules`, and the resolved cache directory, admits declaration files
 * through the shared SafeFs policy, and rejects a symlinked declaration file
 * outright.
 *
 * @since 0.1.0
 */
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { PackageError } from "./PackageError.ts"

const posix = (value: string): string => value.split(NodePath.sep).join("/")

const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Hard traversal ceilings; a workspace beyond them fails, never truncates. */
const limits = {
  directories: 100_000,
  depth: 256,
  entries: 1_000_000
}

const fixedStoreDirectory = ".flows/store"

/**
 * The discovered declaration inventory of one workspace.
 *
 * All paths are workspace-relative posix, sorted by UTF-16 code unit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Discovery {
  /** The canonical workspace root. */
  readonly root: string
  /** `.smithers/WORKSPACE.ts`, or the root `WORKSPACE.ts` fallback. */
  readonly workspaceFile: string
  /** Every exact-case `PACKAGE.ts` in the tree. */
  readonly packageFiles: ReadonlyArray<string>
  /** The cache directory the walk pruned. */
  readonly cacheDirectory: string
}

/**
 * The nearest ancestor of `start` that holds a workspace declaration, or
 * undefined when no ancestor does.
 *
 * The presence probe is deliberately cheap — an `lstat` per candidate — and
 * decides only which mode the CLI runs in; {@link discover} re-admits the
 * file under the full SafeFs policy.
 *
 * @category discovery
 * @since 0.1.0
 */
export const findWorkspaceRoot = async (start: string): Promise<string | undefined> => {
  let directory = NodePath.resolve(start)
  while (true) {
    for (
      const candidate of [
        NodePath.join(directory, ".smithers", "WORKSPACE.ts"),
        NodePath.join(directory, "WORKSPACE.ts")
      ]
    ) {
      try {
        const stats = await Fs.lstat(candidate)
        if (stats.isFile() || stats.isSymbolicLink()) return directory
      } catch {
        // Absent is the common case; every other failure re-surfaces when
        // discover() admits the file properly.
      }
    }
    const parent = NodePath.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The workspace declaration file a root holds: `.smithers/WORKSPACE.ts`
 * first, the root `WORKSPACE.ts` fallback, or undefined when neither
 * exists. A cheap lstat probe like {@link findWorkspaceRoot}; {@link discover}
 * re-admits the file under the full SafeFs policy.
 *
 * @category discovery
 * @since 0.1.0
 */
export const workspaceFileOf = async (root: string): Promise<string | undefined> => {
  for (const candidate of [".smithers/WORKSPACE.ts", "WORKSPACE.ts"]) {
    try {
      const stats = await Fs.lstat(NodePath.join(root, candidate))
      if (stats.isFile()) return candidate
    } catch {
      // Absent is the common case; discover() reports every other failure.
    }
  }
  return undefined
}

interface Walk {
  readonly root: string
  readonly cacheDirectory: string
  /** This workspace's own descriptor, which never marks a nested workspace. */
  readonly workspaceFile: string
  readonly signal: AbortSignal | undefined
  readonly found: Array<string>
  directories: number
  entries: number
}

const pruned = (walk: Walk, child: string): boolean =>
  child === walk.cacheDirectory ||
  child.startsWith(`${walk.cacheDirectory}/`) ||
  child === fixedStoreDirectory ||
  child.startsWith(`${fixedStoreDirectory}/`)

/**
 * Whether a child directory starts a nested package workspace.
 *
 * The workspace's own descriptor is excluded: a repository whose root
 * declaration is `.smithers/WORKSPACE.ts` would otherwise see its own
 * `.smithers/` directory as a nested workspace and prune it from the walk.
 */
const nestedWorkspace = async (walk: Walk, child: string): Promise<boolean> => {
  const probes = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts"]
    .filter((relative) => `${child}/${relative}` !== walk.workspaceFile)
    .map(async (relative) => {
      try {
        const stats = await Fs.lstat(NodePath.join(walk.root, child, relative))
        return stats.isFile() || stats.isSymbolicLink()
      } catch {
        // Absent is the common case; admission errors surface when that
        // nested workspace is selected directly.
        return false
      }
    })
  return (await Promise.all(probes)).some((found) => found)
}

const walkDirectory = async (walk: Walk, relative: string): Promise<void> => {
  walk.signal?.throwIfAborted()
  const depth = relative === "" ? 0 : relative.split("/").length
  if (depth > limits.depth) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its depth limit of ${limits.depth}`, {
      path: relative
    })
  }
  const absolute = NodePath.join(walk.root, relative)
  const entry = await SafeFs.resolveDirectory(absolute, { root: walk.root, what: "workspace directory" })
  if (entry === undefined) return
  walk.directories += 1
  if (walk.directories > limits.directories) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its directory limit of ${limits.directories}`)
  }
  const entries = await SafeFs.listDirectory(absolute, entry, { root: walk.root, what: "workspace directory" })
  walk.entries += entries.length
  if (walk.entries > limits.entries) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its entry limit of ${limits.entries}`)
  }
  // Classify this listing without I/O, then descend into every child
  // directory concurrently. The walk is latency-bound on per-directory stat
  // calls rather than CPU-bound, so a serial descent costs seconds on a
  // workspace with thousands of directories. Concurrency cannot change the
  // inventory: `walk.found` is sorted by the caller, so discovery order never
  // escapes this function.
  const directories: Array<string> = []
  for (const child of entries) {
    walk.signal?.throwIfAborted()
    if (child.name === ".git" || child.name === "node_modules") continue
    const childRelative = relative === "" ? child.name : `${relative}/${child.name}`
    if (pruned(walk, childRelative)) continue
    if (child.name === "PACKAGE.ts" && !child.isDirectory()) {
      if (child.isSymbolicLink()) {
        throw new PackageError(
          "module_not_regular",
          "PACKAGE.ts is a symbolic link; declaration modules must be regular files",
          {
            path: childRelative
          }
        )
      }
      if (!child.isFile()) {
        throw new PackageError("module_not_regular", "PACKAGE.ts is not a regular file", { path: childRelative })
      }
      walk.found.push(childRelative)
      continue
    }
    if (child.isDirectory()) directories.push(childRelative)
  }
  await Promise.all(directories.map(async (childRelative) => {
    if (!(await nestedWorkspace(walk, childRelative))) await walkDirectory(walk, childRelative)
  }))
}

/** Admits one declaration file: regular, contained, and never a symlink. */
const admitDeclaration = async (root: string, relative: string): Promise<boolean> => {
  const entry = await SafeFs.resolveFile(NodePath.join(root, relative), {
    root,
    what: relative.endsWith("WORKSPACE.ts") ? "WORKSPACE.ts" : "PACKAGE.ts",
    symlinks: "reject"
  })
  return entry !== undefined
}

/**
 * Discovers the workspace's declaration files without evaluating any of
 * them.
 *
 * @category discovery
 * @since 0.1.0
 */
export const discover = async (
  root: string,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<Discovery> => {
  const canonical = await SafeFs.canonicalRoot(root)
  const cacheDirectory = posix(options.cacheDirectory ?? ".flows")
  let workspaceFile: string | undefined
  for (const candidate of [".smithers/WORKSPACE.ts", "WORKSPACE.ts"]) {
    let present: boolean
    try {
      present = await admitDeclaration(canonical, candidate)
    } catch (cause) {
      throw new PackageError("module_not_regular", "the workspace declaration could not be admitted", {
        path: candidate,
        cause
      })
    }
    if (present) {
      workspaceFile = candidate
      break
    }
  }
  if (workspaceFile === undefined) {
    throw new PackageError(
      "workspace_root_invalid",
      "the workspace root has no .smithers/WORKSPACE.ts and no WORKSPACE.ts",
      { path: posix(NodePath.relative(process.cwd(), canonical)) || "." }
    )
  }
  const walk: Walk = {
    root: canonical,
    cacheDirectory,
    workspaceFile,
    signal: options.signal,
    found: [],
    directories: 0,
    entries: 0
  }
  await walkDirectory(walk, "")
  const packageFiles = [...walk.found].sort(byCodeUnit)
  // A symlinked PACKAGE.ts inside the walk already failed; re-admission here
  // closes the directory-rename race between the listing and the import.
  for (const file of packageFiles) {
    const admitted = await admitDeclaration(canonical, file)
    if (!admitted) {
      throw new PackageError("module_missing", "PACKAGE.ts disappeared during discovery", { path: file })
    }
  }
  const folded = new Map<string, string>()
  for (const file of packageFiles) {
    const key = file.toLowerCase()
    const existing = folded.get(key)
    if (existing !== undefined) {
      throw new PackageError(
        "case_collision",
        `two declaration paths collide case-insensitively: ${existing} and ${file}`,
        {
          path: file
        }
      )
    }
    folded.set(key, file)
  }
  return { root: canonical, workspaceFile, packageFiles, cacheDirectory }
}
