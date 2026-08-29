/**
 * Host filesystem mechanics for package-mode execution: PATH lookup and
 * version probes for tool references, the content-addressed artifact store
 * behind `Shell.Build` outDirs, git-based write-set snapshots with
 * out-of-set revert, and scratch copies for check-mode drift runs.
 *
 * Everything here is deliberately free of planning and scheduling concerns:
 * `PackageExec.ts` decides what to run and in which mode; this module owns
 * how trees are measured, captured, restored, and confined.
 *
 * @since 0.1.0
 */
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"

const posix = (value: string): string => value.split(NodePath.sep).join("/")

/**
 * The sha256 hex digest of one buffer.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * The sha256 hex digest of one file's bytes, streamed.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digestFileBytes = async (path: string): Promise<string> => {
  const hash = createHash("sha256")
  const handle = await Fs.open(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(1 << 16)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

/**
 * Searches the host PATH for one executable, returning its absolute path or
 * undefined.
 *
 * @category tools
 * @since 0.1.0
 */
export const findOnPath = (name: string): string | undefined => {
  return findAllOnPath(name)[0]
}

/**
 * Searches every PATH entry for an executable, preserving PATH order.
 *
 * @category tools
 * @since 0.1.0
 */
export const findAllOnPath = (name: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const environmentPath = process.env["PATH"] ?? ""
  for (const entry of environmentPath.split(NodePath.delimiter)) {
    if (entry === "") continue
    const candidate = NodePath.join(entry, name)
    try {
      NodeFs.accessSync(candidate, NodeFs.constants.X_OK)
      if (NodeFs.statSync(candidate).isFile() && !found.includes(candidate)) found.push(candidate)
    } catch {
      continue
    }
  }
  return found
}

/**
 * One completed `--version` probe: bounded output plus the exit code.
 *
 * @category tools
 * @since 0.1.0
 */
export interface Probe {
  readonly exitCode: number
  readonly output: string
}

const probeOutputLimit = 2 * 1024

/**
 * Runs `<path> --version` once and captures bounded output.
 *
 * Tools without a `--version` flag still probe deterministically: whatever
 * they print plus their exit code is the identity. The probe result is key
 * material, so callers memoize it per command.
 *
 * `args` overrides the probe argv for a tool whose version lives behind a
 * subcommand rather than a flag (`go version`), and `cwd` runs the probe
 * inside a directory whose configuration selects the version (a Go module
 * whose `go.mod` makes `GOTOOLCHAIN` switch toolchains).
 *
 * @category tools
 * @since 0.1.0
 */
export const probeVersion = (
  path: string,
  options?: { readonly cwd?: string | undefined; readonly args?: ReadonlyArray<string> | undefined }
): Promise<Probe> =>
  probeCommand(path, options?.args ?? ["--version"], options?.cwd === undefined ? undefined : { cwd: options.cwd })

/**
 * Runs one bounded tool identity/readiness command.
 *
 * @category tools
 * @since 0.1.0
 */
export const probeCommand = (
  path: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string | undefined }
): Promise<Probe> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      path,
      [...args],
      { timeout: 10_000, maxBuffer: 1 << 20, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) },
      (error, stdout, stderr) => {
        const exitCode = error === null
          ? 0
          : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        const output = `${stdout}${stderr}`.slice(0, probeOutputLimit)
        resolve({ exitCode, output })
      }
    )
  })

/**
 * Runs git in a workspace and returns stdout, throwing on a non-zero exit.
 *
 * @category git
 * @since 0.1.0
 */
export const runGit = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", root, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) reject(new Error(`git ${args[0]} failed: ${error.message}`))
        else resolve(stdout)
      }
    )
  })

/** One `git status --porcelain -z` row. */
interface StatusEntry {
  readonly status: string
  readonly path: string
}

const parseStatusZ = (raw: string): Array<StatusEntry> => {
  const entries: Array<StatusEntry> = []
  const parts = raw.split("\0")
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    if (part === "") continue
    const status = part.slice(0, 2)
    const path = part.slice(3)
    if (path === "") continue
    entries.push({ status, path })
    // A rename/copy row carries the original path as the next NUL field.
    if (status.startsWith("R") || status.startsWith("C")) index += 1
  }
  return entries
}

/**
 * The recorded state of one dirty path.
 *
 * @category write sets
 * @since 0.1.0
 */
export type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "file"; readonly digest: string; readonly executable: boolean }

/**
 * Measures the state of one absolute path: missing, a symlink with its
 * target, or a file with its content digest and executable bit.
 *
 * @category write sets
 * @since 0.1.0
 */
export const pathState = (absolute: string): Promise<PathState> => statePath(absolute)

const statePath = async (absolute: string): Promise<PathState> => {
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(absolute)
  } catch {
    return { kind: "missing" }
  }
  if (stats.isSymbolicLink()) return { kind: "link", target: await Fs.readlink(absolute) }
  if (stats.isFile()) {
    return {
      kind: "file",
      digest: await digestFileBytes(absolute),
      executable: (stats.mode & 0o111) !== 0
    }
  }
  return { kind: "missing" }
}

const sameState = (left: PathState, right: PathState): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === "link" && right.kind === "link") return left.target === right.target
  if (left.kind === "file" && right.kind === "file") {
    return left.digest === right.digest && left.executable === right.executable
  }
  return true
}

/**
 * A snapshot of the workspace's dirty state relative to git HEAD: every
 * modified, deleted, and untracked path with its content state, plus a stash
 * of the dirty files' bytes so an out-of-set change to an already-dirty file
 * can be reverted to exactly what it held before the tool ran.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface TreeSnapshot {
  readonly root: string
  readonly states: ReadonlyMap<string, PathState>
  readonly stashDirectory: string
}

const skipStatusPath = (cacheDirectory: string, path: string): boolean =>
  path === cacheDirectory || path.startsWith(`${cacheDirectory}/`) ||
  // Version-control internals are host state, never workspace source.
  path === ".git" || path.startsWith(".git/") || path === ".jj" || path.startsWith(".jj/") ||
  // The installed dependency tree is host state, not workspace source: in the
  // e2e clone it is a symlink into the live checkout, and its cache writes are
  // expected. It is kept out of the write-set entirely rather than reverted.
  path === "node_modules" || path.startsWith("node_modules/")

/**
 * Records the dirty state of a git workspace before a tool runs.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotTree = async (root: string, cacheDirectory: string): Promise<TreeSnapshot> => {
  // Gitignored paths are handled by the separate, content-free ignored guard
  // ({@link snapshotIgnored}); hashing and stashing the whole ignored tree
  // here — the gitignored build artifacts and the jj store among it — would be
  // a per-run cost out of all proportion to the dirty source set this measures.
  const raw = await runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"])
  const states = new Map<string, PathState>()
  const stashDirectory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-writeset-"))
  for (const entry of parseStatusZ(raw)) {
    if (skipStatusPath(cacheDirectory, entry.path)) continue
    const absolute = NodePath.join(root, entry.path)
    const state = await statePath(absolute)
    states.set(entry.path, state)
    if (state.kind === "file") {
      const stashFile = NodePath.join(stashDirectory, digestBytes(Buffer.from(entry.path, "utf8")))
      await Fs.copyFile(absolute, stashFile)
    } else if (state.kind === "link") {
      // Link state is fully described by its target text; nothing to stash.
    }
  }
  return { root, states, stashDirectory }
}

/**
 * The set of paths whose state changed since a snapshot, resolved through
 * symlinks: a write through an in-tree link is judged by where it landed.
 *
 * @category write sets
 * @since 0.1.0
 */
export const changedSinceSnapshot = async (
  snapshot: TreeSnapshot,
  cacheDirectory: string
): Promise<ReadonlyArray<string>> => {
  const raw = await runGit(snapshot.root, ["status", "--porcelain", "-z", "--untracked-files=all"])
  const after = new Map<string, PathState>()
  for (const entry of parseStatusZ(raw)) {
    if (skipStatusPath(cacheDirectory, entry.path)) continue
    after.set(entry.path, await statePath(NodePath.join(snapshot.root, entry.path)))
  }
  const changed = new Set<string>()
  for (const [path, state] of after) {
    const before = snapshot.states.get(path)
    if (before === undefined || !sameState(before, state)) changed.add(path)
  }
  for (const path of snapshot.states.keys()) {
    if (after.has(path)) continue
    // The path settled back to its HEAD state: the tool overwrote or removed
    // a difference that existed before it ran, which is a change.
    changed.add(path)
  }
  return [...changed].sort()
}

/**
 * Resolves one changed path through symlinks to the workspace-relative
 * location the bytes actually landed at, or undefined when the real location
 * leaves the workspace.
 *
 * @category write sets
 * @since 0.1.0
 */
export const resolveChangedPath = (root: string, path: string): string | undefined => {
  const absolute = NodePath.join(root, path)
  let real: string
  try {
    real = NodeFs.realpathSync(absolute)
  } catch {
    // The path no longer exists (a deletion); judge it by its lexical spot
    // resolved through the nearest existing ancestor.
    try {
      real = NodePath.join(NodeFs.realpathSync(NodePath.dirname(absolute)), NodePath.basename(absolute))
    } catch {
      return posix(path)
    }
  }
  const realRoot = NodeFs.realpathSync(root)
  const relative = NodePath.relative(realRoot, real)
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) return undefined
  return posix(relative)
}

/**
 * Restores one path to its snapshot state.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertPath = async (snapshot: TreeSnapshot, path: string): Promise<void> => {
  const absolute = NodePath.join(snapshot.root, path)
  const before = snapshot.states.get(path)
  if (before === undefined) {
    // The path was clean before the tool ran: a tracked file goes back to
    // HEAD, a fresh untracked file is deleted.
    const tracked = await runGit(snapshot.root, ["ls-files", "--error-unmatch", "--", path]).then(
      () => true,
      () => false
    )
    if (tracked) {
      await runGit(snapshot.root, ["checkout", "--force", "--", path])
    } else {
      await Fs.rm(absolute, { recursive: true, force: true })
    }
    return
  }
  if (before.kind === "missing") {
    await Fs.rm(absolute, { recursive: true, force: true })
    return
  }
  if (before.kind === "link") {
    await Fs.rm(absolute, { recursive: true, force: true })
    await Fs.symlink(before.target, absolute)
    return
  }
  const stashFile = NodePath.join(snapshot.stashDirectory, digestBytes(Buffer.from(path, "utf8")))
  await Fs.rm(absolute, { recursive: true, force: true })
  await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
  await Fs.copyFile(stashFile, absolute)
  await Fs.chmod(absolute, before.executable ? 0o755 : 0o644)
}

/**
 * Releases the stash a snapshot holds.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releaseSnapshot = async (snapshot: TreeSnapshot): Promise<void> => {
  await Fs.rm(snapshot.stashDirectory, { recursive: true, force: true })
}

/** The cheap identity of one gitignored path: presence, kind, and size/mtime. */
interface IgnoredEntry {
  readonly kind: "file" | "link" | "dir"
  readonly size: number
  readonly mtimeMs: number
}

/**
 * A content-free snapshot of the workspace's gitignored paths before a tool
 * runs.
 *
 * `git status` omits ignored paths unless asked, so an out-of-set write to a
 * gitignored path is invisible to {@link changedSinceSnapshot}. This guard
 * closes that gap without the cost of the full write-set snapshot: it records
 * only each ignored path's name and `lstat` identity — no content is read,
 * hashed, or stashed — so the potentially large gitignored trees (build
 * artifacts, the jj store) are not walked byte for byte on every run.
 * `node_modules`, the cache, and version-control internals are excluded.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredSnapshot {
  readonly root: string
  readonly entries: ReadonlyMap<string, IgnoredEntry>
}

const listIgnored = async (root: string, cacheDirectory: string): Promise<Map<string, IgnoredEntry>> => {
  const raw = await runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignored"]).catch(() => "")
  const entries = new Map<string, IgnoredEntry>()
  for (const status of parseStatusZ(raw)) {
    if (!status.status.startsWith("!!")) continue
    const path = status.path.endsWith("/") ? status.path.slice(0, -1) : status.path
    if (path === "" || skipStatusPath(cacheDirectory, path)) continue
    let stats: NodeFs.Stats
    try {
      stats = await Fs.lstat(NodePath.join(root, path))
    } catch {
      continue
    }
    const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file"
    entries.set(path, { kind, size: stats.size, mtimeMs: stats.mtimeMs })
  }
  return entries
}

/**
 * Records the gitignored paths present before a tool runs.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotIgnored = async (root: string, cacheDirectory: string): Promise<IgnoredSnapshot> => ({
  root,
  entries: await listIgnored(root, cacheDirectory)
})

/**
 * The gitignored paths a tool created or overwrote since the snapshot,
 * resolved through symlinks like {@link changedSinceSnapshot}.
 *
 * @category write sets
 * @since 0.1.0
 */
export const changedIgnored = async (
  snapshot: IgnoredSnapshot,
  cacheDirectory: string
): Promise<ReadonlyArray<string>> => {
  const after = await listIgnored(snapshot.root, cacheDirectory)
  const changed = new Set<string>()
  for (const [path, entry] of after) {
    const before = snapshot.entries.get(path)
    if (
      before === undefined ||
      before.kind !== entry.kind ||
      before.size !== entry.size ||
      before.mtimeMs !== entry.mtimeMs
    ) {
      changed.add(path)
    }
  }
  return [...changed].sort()
}

/**
 * Reverts one gitignored path a tool wrote out of set.
 *
 * A gitignored path's prior bytes are not stashed (the ignored tree is never
 * copied), so the revert deletes the offending path. A newly created leak is
 * removed entirely; an overwritten pre-existing ignored file — a rare, always
 * out-of-set event, since an in-set ignored write is kept — is removed rather
 * than restored, which still undoes the unauthorized write of a regenerable
 * ignored artifact.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertIgnored = async (snapshot: IgnoredSnapshot, path: string): Promise<void> => {
  await Fs.rm(NodePath.join(snapshot.root, path), { recursive: true, force: true })
}

/**
 * One in-workspace symlink whose real target lies outside the workspace: a
 * portal a tool could write through to escape the tree, judged by resolved
 * location per the write-set rules.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface Portal {
  readonly link: string
  readonly realTarget: string
  readonly states: ReadonlyMap<string, PathState>
}

/**
 * A snapshot of every escaping-symlink portal's target contents before a tool
 * runs, plus a stash of their file bytes so a write through a portal can be
 * reverted.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface PortalSnapshot {
  readonly root: string
  readonly portals: ReadonlyArray<Portal>
  readonly stashDirectory: string
}

/** The largest portal target the guard measures; a larger one is left unconfined. */
const portalEntryCap = 20_000

const portalStashKey = (index: number, relative: string): string =>
  digestBytes(Buffer.from(`${index}\0${relative}`, "utf8"))

/** Walks one portal target into a relative-path → state map, or throws on overflow. */
const walkPortalTarget = async (realTarget: string): Promise<Map<string, PathState>> => {
  const states = new Map<string, PathState>()
  let count = 0
  const rootStats = await Fs.lstat(realTarget)
  if (!rootStats.isDirectory()) {
    states.set("", await statePath(realTarget))
    return states
  }
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await Fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      count += 1
      if (count > portalEntryCap) throw new Error("portal target too large")
      const childAbsolute = NodePath.join(directory, entry.name)
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(childAbsolute, childRelative)
      } else {
        states.set(childRelative, await statePath(childAbsolute))
      }
    }
  }
  await walk(realTarget, "")
  return states
}

const listTrackedSymlinks = async (root: string): Promise<Array<string>> => {
  const raw = await runGit(root, ["ls-files", "-s", "-z"]).catch(() => "")
  const paths: Array<string> = []
  for (const part of raw.split("\0")) {
    if (part === "") continue
    const tab = part.indexOf("\t")
    if (tab < 0) continue
    if (part.slice(0, tab).startsWith("120000")) paths.push(part.slice(tab + 1))
  }
  return paths
}

/**
 * Records every escaping-symlink portal's target before a tool runs.
 *
 * Portals are the in-workspace symlinks — tracked or untracked — whose real
 * target leaves the workspace. `node_modules`, `.git`, and the cache are
 * excluded (`node_modules` is installed host state whose writes are expected),
 * and a target larger than {@link portalEntryCap} entries is left unconfined
 * and reported through `onUnbounded` rather than walked. Git cannot see a
 * write that lands through such a symlink, so the portal's contents are
 * measured directly here and again after the run.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotPortals = async (
  root: string,
  cacheDirectory: string,
  onUnbounded?: (link: string) => void
): Promise<PortalSnapshot> => {
  const realRoot = await Fs.realpath(root)
  const candidates = new Set<string>(await listTrackedSymlinks(root))
  const statusRaw = await runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignored"]).catch(
    () => ""
  )
  for (const entry of parseStatusZ(statusRaw)) {
    const path = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path
    if (path !== "") candidates.add(path)
  }
  const stashDirectory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-portal-"))
  const portals: Array<Portal> = []
  let index = 0
  for (const link of [...candidates].sort()) {
    if (skipStatusPath(cacheDirectory, link)) continue
    const absolute = NodePath.join(root, link)
    let stats: NodeFs.Stats
    try {
      stats = await Fs.lstat(absolute)
    } catch {
      continue
    }
    if (!stats.isSymbolicLink()) continue
    let realTarget: string
    try {
      realTarget = await Fs.realpath(absolute)
    } catch {
      continue
    }
    const relative = NodePath.relative(realRoot, realTarget)
    // A symlink resolving inside the workspace is judged by the git write-set,
    // not here; only an escaping one is a portal.
    if (relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative))) continue
    let states: Map<string, PathState>
    try {
      states = await walkPortalTarget(realTarget)
    } catch {
      onUnbounded?.(link)
      continue
    }
    for (const [relativePath, state] of states) {
      if (state.kind === "file") {
        const source = relativePath === "" ? realTarget : NodePath.join(realTarget, ...relativePath.split("/"))
        await Fs.copyFile(source, NodePath.join(stashDirectory, portalStashKey(index, relativePath)))
      }
    }
    portals.push({ link, realTarget, states })
    index += 1
  }
  return { root, portals, stashDirectory }
}

/**
 * Reverts every write that landed through a portal since the snapshot and
 * returns the escaped paths, workspace-relative through their portal link.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertChangedPortals = async (snapshot: PortalSnapshot): Promise<ReadonlyArray<string>> => {
  const escaped: Array<string> = []
  for (const [index, portal] of snapshot.portals.entries()) {
    let after: Map<string, PathState>
    try {
      after = await walkPortalTarget(portal.realTarget)
    } catch {
      continue
    }
    const changed = new Set<string>()
    for (const [relativePath, state] of after) {
      const before = portal.states.get(relativePath)
      if (before === undefined || !sameState(before, state)) changed.add(relativePath)
    }
    for (const relativePath of portal.states.keys()) {
      if (!after.has(relativePath)) changed.add(relativePath)
    }
    for (const relativePath of [...changed].sort()) {
      const target = relativePath === ""
        ? portal.realTarget
        : NodePath.join(portal.realTarget, ...relativePath.split("/"))
      const before = portal.states.get(relativePath)
      if (before === undefined || before.kind === "missing") {
        await Fs.rm(target, { recursive: true, force: true })
      } else if (before.kind === "link") {
        await Fs.rm(target, { recursive: true, force: true })
        await Fs.mkdir(NodePath.dirname(target), { recursive: true })
        await Fs.symlink(before.target, target)
      } else {
        await Fs.rm(target, { recursive: true, force: true })
        await Fs.mkdir(NodePath.dirname(target), { recursive: true })
        await Fs.copyFile(NodePath.join(snapshot.stashDirectory, portalStashKey(index, relativePath)), target)
        await Fs.chmod(target, before.executable ? 0o755 : 0o644)
      }
      escaped.push(relativePath === "" ? portal.link : `${portal.link}/${relativePath}`)
    }
  }
  return escaped.sort()
}

/**
 * Releases the stash a portal snapshot holds.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releasePortals = async (snapshot: PortalSnapshot): Promise<void> => {
  await Fs.rm(snapshot.stashDirectory, { recursive: true, force: true })
}

/**
 * Copies the workspace to a scratch directory for a check-mode run.
 *
 * `.git`, the cache directory, and `node_modules` contents are skipped;
 * symlinks — the e2e clone's node_modules among them — are copied verbatim,
 * so the scratch tree reads the same installed tools without duplicating
 * them. `skip` names further workspace-relative roots the caller is going to
 * clear anyway — an overlay build's own `outDirs` — so a large previous
 * output is not copied only to be deleted.
 *
 * @category scratch
 * @since 0.1.0
 */
export const scratchCopy = async (
  root: string,
  cacheDirectory: string,
  skip: ReadonlyArray<string> = []
): Promise<string> => {
  const destination = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-scratch-"))
  const cacheAbsolute = NodePath.join(root, ...cacheDirectory.split("/"))
  const gitAbsolute = NodePath.join(root, ".git")
  const nodeModulesAbsolute = NodePath.join(root, "node_modules")
  const skipped = new Set(skip.map((path) => NodePath.join(root, ...path.split("/"))))
  await Fs.cp(root, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) =>
      source !== cacheAbsolute && source !== gitAbsolute && source !== nodeModulesAbsolute && !skipped.has(source)
  })
  if (await Fs.lstat(nodeModulesAbsolute).then(() => true, () => false)) {
    await Fs.symlink(nodeModulesAbsolute, NodePath.join(destination, "node_modules"), "dir")
  }
  return destination
}

/**
 * One entry of a captured output tree.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface ManifestEntry {
  readonly path: string
  readonly kind: "file" | "link"
  readonly digest: string
  readonly executable: boolean
  readonly target: string
}

/**
 * One captured output root: the workspace-relative outDir plus its entries.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface OutDirManifest {
  readonly outDir: string
  readonly entries: ReadonlyArray<ManifestEntry>
}

/** One captured file output stored in the same content-addressed blob set.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface FileManifest {
  readonly path: string
  readonly digest: string
  readonly executable: boolean
}

const casDirectory = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "cas")

const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Captures one produced outDir tree into the CAS and returns its manifest.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const captureOutDir = async (
  root: string,
  cacheDirectory: string,
  outDir: string,
  storeRoot: string = root
): Promise<OutDirManifest> => {
  const absolute = NodePath.join(root, ...outDir.split("/"))
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(absolute)
  } catch {
    throw new Error(`declared outDir was not created: ${outDir}`)
  }
  if (!stats.isDirectory()) throw new Error(`declared outDir is not a directory: ${outDir}`)
  const cas = casDirectory(storeRoot, cacheDirectory)
  await Fs.mkdir(cas, { recursive: true })
  const entries: Array<ManifestEntry> = []
  const walk = async (directory: string, relative: string): Promise<void> => {
    const names = (await Fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => byCodeUnit(left.name, right.name))
    for (const entry of names) {
      const childAbsolute = NodePath.join(directory, entry.name)
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) {
        entries.push({
          path: childRelative,
          kind: "link",
          digest: "",
          executable: false,
          target: await Fs.readlink(childAbsolute)
        })
      } else if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative)
      } else if (entry.isFile()) {
        const digest = await digestFileBytes(childAbsolute)
        const blob = NodePath.join(cas, digest)
        // A blob is content-addressed, so an existing one of the right name is
        // usually the right bytes. It is not trusted on name alone: a
        // tampered or truncated blob is re-verified against its digest and
        // rewritten from the freshly produced file, so a rebuild heals the CAS
        // instead of leaving it poisoned for every later run to miss on.
        let present: boolean
        try {
          present = (await digestFileBytes(blob)) === digest
        } catch {
          present = false
        }
        if (!present) {
          const temp = `${blob}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
          await Fs.copyFile(childAbsolute, temp)
          await Fs.rename(temp, blob)
        }
        const mode = (await Fs.stat(childAbsolute)).mode
        entries.push({
          path: childRelative,
          kind: "file",
          digest,
          executable: (mode & 0o111) !== 0,
          target: ""
        })
      }
    }
  }
  await walk(absolute, "")
  return { outDir, entries }
}

/** Captures one declared output file into the CAS.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const captureFile = async (
  root: string,
  cacheDirectory: string,
  path: string,
  storeRoot: string = root
): Promise<FileManifest> => {
  if (!isConfinedRelative(path)) throw new Error(`declared output file leaves the workspace: ${path}`)
  const absolute = NodePath.join(root, ...path.split("/"))
  const stats = await Fs.lstat(absolute).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) throw new Error(`declared output file was not created: ${path}`)
  const digest = await digestFileBytes(absolute)
  const cas = casDirectory(storeRoot, cacheDirectory)
  await Fs.mkdir(cas, { recursive: true })
  const blob = NodePath.join(cas, digest)
  if (!await Fs.access(blob).then(() => true, () => false)) await Fs.copyFile(absolute, blob)
  return { path, digest, executable: (stats.mode & 0o111) !== 0 }
}

/** Decodes an untrusted file manifest.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const decodeFileManifest = (value: unknown): FileManifest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const path = (value as { readonly path?: unknown }).path
  const digest = (value as { readonly digest?: unknown }).digest
  const executable = (value as { readonly executable?: unknown }).executable
  if (typeof path !== "string" || !isConfinedRelative(path)) return undefined
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || typeof executable !== "boolean") return undefined
  return { path, digest, executable }
}

/** Verifies that one file manifest's CAS blob exists and matches its name.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const verifyFileManifest = async (
  root: string,
  cacheDirectory: string,
  manifest: FileManifest
): Promise<string | undefined> => {
  const blob = NodePath.join(casDirectory(root, cacheDirectory), manifest.digest)
  const digest = await digestFileBytes(blob).catch(() => undefined)
  if (digest === undefined) return `cas blob missing for ${manifest.path}`
  if (digest !== manifest.digest) return `cas blob tampered for ${manifest.path}`
  return undefined
}

/** Atomically restores one captured file output from the CAS.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const materializeFile = async (
  root: string,
  cacheDirectory: string,
  manifest: FileManifest
): Promise<void> => {
  if (!isConfinedRelative(manifest.path)) throw new Error(`materialize refused path: ${manifest.path}`)
  const destination = NodePath.join(root, ...manifest.path.split("/"))
  const blob = NodePath.join(casDirectory(root, cacheDirectory), manifest.digest)
  await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
  const temporary = `${destination}.smthrs-${process.pid}-${Math.random().toString(16).slice(2)}`
  await Fs.copyFile(blob, temporary)
  await Fs.chmod(temporary, manifest.executable ? 0o755 : 0o644)
  await Fs.rename(temporary, destination)
}

const safeManifestPath = /^(?!\.\.(\/|$))(?!\/)[^\0]+$/

/**
 * A workspace-relative path that cannot escape its root: non-empty, not
 * absolute, no `..` segment (in either separator), no NUL. Used for a
 * manifest's `outDir` and its entry paths, both read back from an untrusted
 * cache.
 */
const isConfinedRelative = (value: string): boolean =>
  value !== "" &&
  !value.includes("\0") &&
  !NodePath.isAbsolute(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..") &&
  !value.split(NodePath.sep).includes("..")

/**
 * A symlink target that cannot point out of the tree it is materialized into:
 * not absolute, no `..` segment. A capture only ever records such targets;
 * an untrusted manifest that names an absolute or `..`-bearing target is
 * refused, because materializing it — or writing a later entry through it —
 * would leave the outDir.
 */
const isConfinedLinkTarget = (value: string): boolean =>
  value !== "" &&
  !value.includes("\0") &&
  !NodePath.isAbsolute(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..") &&
  !value.split(NodePath.sep).includes("..")

/**
 * Validates one untrusted manifest read back from the cache.
 *
 * The manifest is untrusted input: the local `.flows` entry file, a shared
 * remote body, a backup, or a hand edit. Every path it names is bound to the
 * outDir tree here so a poisoned entry cannot escape the workspace. `outDir`
 * is confined to a workspace-relative path with no `..` segment, every entry
 * path is likewise confined, and every link target is confined so a later
 * file entry cannot be written through a symlink that leaves the tree. The
 * caller must still bind the returned `outDir` to a declared output root
 * before materializing it.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const decodeManifest = (value: unknown): OutDirManifest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const outDir = (value as { readonly outDir?: unknown }).outDir
  const entries = (value as { readonly entries?: unknown }).entries
  if (typeof outDir !== "string" || !isConfinedRelative(outDir) || !Array.isArray(entries)) return undefined
  const decoded: Array<ManifestEntry> = []
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined
    const path = (entry as { readonly path?: unknown }).path
    const kind = (entry as { readonly kind?: unknown }).kind
    const digest = (entry as { readonly digest?: unknown }).digest
    const executable = (entry as { readonly executable?: unknown }).executable
    const target = (entry as { readonly target?: unknown }).target
    if (
      typeof path !== "string" || !safeManifestPath.test(path) || !isConfinedRelative(path) ||
      (kind !== "file" && kind !== "link") ||
      typeof digest !== "string" ||
      (kind === "file" && !/^[0-9a-f]{64}$/.test(digest)) ||
      typeof executable !== "boolean" ||
      typeof target !== "string" ||
      (kind === "link" && !isConfinedLinkTarget(target))
    ) return undefined
    decoded.push({ path, kind, digest, executable, target })
  }
  return { outDir, entries: decoded }
}

/**
 * Verifies every blob a manifest names, returning the first problem or
 * undefined when the store can materialize the whole tree.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const verifyManifestBlobs = async (
  root: string,
  cacheDirectory: string,
  manifest: OutDirManifest
): Promise<string | undefined> => {
  const cas = casDirectory(root, cacheDirectory)
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue
    const blob = NodePath.join(cas, entry.digest)
    let digest: string
    try {
      digest = await digestFileBytes(blob)
    } catch {
      return `cas blob missing for ${manifest.outDir}/${entry.path}`
    }
    if (digest !== entry.digest) return `cas blob tampered for ${manifest.outDir}/${entry.path}`
  }
  return undefined
}

/**
 * Materializes one manifest tree atomically: the tree is fully built as a
 * temp sibling, then rename-swapped over the outDir root.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const materializeManifest = async (
  root: string,
  cacheDirectory: string,
  manifest: OutDirManifest
): Promise<void> => {
  const cas = casDirectory(root, cacheDirectory)
  const absolute = NodePath.join(root, ...manifest.outDir.split("/"))
  const parent = NodePath.dirname(absolute)
  await Fs.mkdir(parent, { recursive: true })
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const temp = NodePath.join(parent, `.smthrs-mat-${stamp}`)
  await Fs.mkdir(temp, { recursive: true })
  const tempReal = await Fs.realpath(temp)
  try {
    for (const entry of manifest.entries) {
      const destination = NodePath.join(temp, ...entry.path.split("/"))
      const parentDirectory = NodePath.dirname(destination)
      await Fs.mkdir(parentDirectory, { recursive: true })
      // Confine every write to the temp tree. `decodeManifest` already refuses
      // `..` and absolute paths and link targets, but a poisoned manifest that
      // slipped a symlink entry ahead of a file entry beneath it would have the
      // file written through the link; resolving the real parent and checking
      // it stays under the temp root closes that write-through path regardless.
      const realParent = await Fs.realpath(parentDirectory)
      const relative = NodePath.relative(tempReal, realParent)
      if (relative !== "" && (relative.startsWith("..") || NodePath.isAbsolute(relative))) {
        throw new Error(`materialize refused a path that leaves the outDir: ${entry.path}`)
      }
      if (entry.kind === "link") {
        await Fs.symlink(entry.target, destination)
      } else {
        await Fs.copyFile(NodePath.join(cas, entry.digest), destination)
        await Fs.chmod(destination, entry.executable ? 0o755 : 0o644)
      }
    }
    const old = NodePath.join(parent, `.smthrs-old-${stamp}`)
    let hadOld = false
    try {
      await Fs.rename(absolute, old)
      hadOld = true
    } catch {
      // The outDir did not exist; the temp tree becomes it directly.
    }
    await Fs.rename(temp, absolute)
    if (hadOld) await Fs.rm(old, { recursive: true, force: true })
  } catch (cause) {
    await Fs.rm(temp, { recursive: true, force: true })
    throw cause
  }
}

/**
 * Compares one manifest against the current working tree, returning the
 * first difference or undefined when the tree matches byte for byte.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const treeMatchesManifest = async (
  root: string,
  manifest: OutDirManifest
): Promise<string | undefined> => {
  const absolute = NodePath.join(root, ...manifest.outDir.split("/"))
  for (const entry of manifest.entries) {
    const state = await statePath(NodePath.join(absolute, ...entry.path.split("/")))
    if (entry.kind === "link") {
      if (state.kind !== "link" || state.target !== entry.target) {
        return `${manifest.outDir}/${entry.path} does not match the captured symlink`
      }
    } else if (state.kind !== "file" || state.digest !== entry.digest) {
      return `${manifest.outDir}/${entry.path} does not match the captured content`
    }
  }
  return undefined
}
