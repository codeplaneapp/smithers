/**
 * The one sandbox every tool run goes through.
 *
 * A target declares a policy (`Attr.Sandbox`): the default confinement, a
 * loopback opening, the full network opening, or the `"none"` opt-out. The
 * surfaces (`PackageExec` for `PACKAGE.ts`, `ExecLive` for `legacy declaration`) turn the
 * policy plus the planner's read and write sets into a {@link Request}; this
 * module turns the request into an argv that the host enforces, or into an
 * {@link Unenforceable} refusal naming what the host lacks.
 *
 * Three mechanisms, one contract:
 *
 * - Linux: bubblewrap. The host root is bind-mounted read-only, a tmpfs covers
 *   the workspace, declared reads are bound read-only at their own paths,
 *   declared writes read-write, the tmpfs is remounted read-only, and the
 *   network namespace is unshared unless the policy opens it. A loopback-only
 *   request is refused because bubblewrap cannot admit the host loopback
 *   interface without granting the whole host network.
 * - macOS: seatbelt (`sandbox-exec`). Reads under the workspace are denied
 *   except the declared set (ancestor directories stay listable), writes are
 *   denied except the declared set and a private tmp, and the network is
 *   denied except what the policy opens. The operating system and the
 *   toolchain outside the workspace stay readable; that is where the dynamic
 *   loader and the interpreters live, and denying them kills every process
 *   before it prints a byte.
 * - Docker: `docker run` with a read-only root, declared reads mounted
 *   read-only at their host paths, declared writes read-write, `--network
 *   none` unless the policy opens it. The image supplies the toolchain. It is
 *   the path on Windows and on any host without the native mechanism.
 *
 * Every declared confinement is enforced or the target fails closed. Nothing
 * here logs "unenforced" and carries on. `S.Sandbox.Microsandbox` is not a
 * build mechanism: it names the runtime sandbox `@smthrs/sandbox` boots for
 * sessions, and a build target declared under it is refused with the
 * mechanisms that do confine builds.
 *
 * @since 0.1.0
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import type * as Attr from "./Attr.ts"
import type * as WorkspaceDeclaration from "./WorkspaceDeclaration.ts"

/**
 * The declared sandbox policy.
 *
 * The literal `"none"` is the confinement opt-out, not a network posture: it
 * asks for no sandbox at all, so the process keeps every access the host
 * gives it, the network included. {@link Network} spells its closed posture
 * with the same word and means the opposite, so read the token against the
 * type carrying it rather than on sight.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = Attr.Sandbox

/**
 * The network posture a policy resolves to. Here `"none"` is a closed
 * network, the opposite of the `"none"` a {@link Policy} spells to drop
 * confinement entirely.
 *
 * @category models
 * @since 0.1.0
 */
export type Network = "none" | "loopback" | "open"

/**
 * What a surface asks for: the policy, the workspace's mechanism choice, and
 * the read and write sets. Every path is workspace-relative and posix-shaped;
 * a read may name a file or a directory, a write names a directory. A
 * `readOnly` entry re-closes a subtree under a declared write.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly policy: Policy | undefined
  readonly mechanism?: WorkspaceDeclaration.SandboxDeclaration | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  /**
   * Declared outputs whose leaf is a file rather than a directory. A file
   * cannot be bound writable on its own and does not exist before the tool
   * writes it, so its parent directory becomes the writable bind. Kept apart
   * from `writes` because only the caller knows which of the two a
   * declaration meant: inferring it from the path would hand a not-yet-created
   * `.cargo-home` or `dist.new` its parent, and a parent that is the
   * workspace root opens the whole workspace for the run.
   */
  readonly writeFiles?: ReadonlyArray<string> | undefined
  readonly readOnly?: ReadonlyArray<string> | undefined
  /**
   * Absolute host paths outside the workspace the tool reads: a git
   * submodule's local source repository, for one. Bound read-only where the
   * mechanism would otherwise hide them; a path that does not exist, or that
   * sits inside the workspace, is dropped.
   */
  readonly externalReads?: ReadonlyArray<string> | undefined
}

/**
 * The host facts mechanism selection reads. Injectable so every platform's
 * argv can be tested on every other platform.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  readonly platform: NodeJS.Platform
  /** Resolves an executable name on `PATH` to an absolute path, or nothing. */
  readonly executable: (name: string) => string | undefined
  /** Whether a host path exists. */
  readonly exists: (path: string) => boolean
  /** Whether a host path is a directory. */
  readonly isDirectory: (path: string) => boolean
  /**
   * The names of a directory's direct children, or undefined when the host
   * cannot list it. Optional: a host without it keeps every declared file as
   * its own entry, which is correct and merely long.
   */
  readonly entries?: ((directory: string) => ReadonlyArray<string> | undefined) | undefined
  /**
   * Where a path's bytes actually live once every symbolic link on it is
   * followed, or `undefined` when the host cannot say. A host that omits it
   * binds declared paths where they sit, which is right everywhere a link's
   * target stays visible.
   */
  readonly realpath?: ((path: string) => string | undefined) | undefined
  readonly uid: number | undefined
  readonly gid: number | undefined
}

/**
 * One selected enforcement mechanism.
 *
 * @category models
 * @since 0.1.0
 */
export type Mechanism =
  | { readonly _tag: "bubblewrap"; readonly executable: string }
  | { readonly _tag: "seatbelt"; readonly executable: string }
  | { readonly _tag: "docker"; readonly executable: string; readonly image: string }
  | { readonly _tag: "none" }

/**
 * The refusal a host that cannot enforce a declared confinement produces.
 *
 * @category models
 * @since 0.1.0
 */
export interface Unenforceable {
  readonly _tag: "smithers-build/SandboxUnenforceable"
  readonly platform: NodeJS.Platform
  readonly mechanism: string
  readonly missing: string
  readonly message: string
}

/**
 * Checks for an {@link Unenforceable} refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isUnenforceable = (value: unknown): value is Unenforceable =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "smithers-build/SandboxUnenforceable"

const unenforceable = (
  platform: NodeJS.Platform,
  mechanism: string,
  missing: string,
  detail: string
): Unenforceable => ({
  _tag: "smithers-build/SandboxUnenforceable",
  platform,
  mechanism,
  missing,
  message: `sandbox: the declared confinement cannot be enforced on this ${platform} host: ${detail}. ` +
    `A confined target never runs unconfined; declare sandbox: "none" on the target to opt out, ` +
    `or declare a mechanism the host has with S.Sandboxes({ default: ... }).`
})

/**
 * The resolved confinement one spawn runs under. Every path is absolute and
 * canonical.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly mechanism: Exclude<Mechanism, { readonly _tag: "none" }>
  readonly network: Network
  readonly workspaceRoot: string
  readonly cwd: string
  readonly reads: ReadonlyArray<string>
  /**
   * Paths inside a granted directory that the declaration did not cover,
   * re-closed after the grant. Only a mechanism with deny rules (seatbelt)
   * folds; the others keep every declared file as its own entry.
   */
  readonly readDenies: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly readOnly: ReadonlyArray<string>
  /**
   * Where a declared read's bytes actually live when the path reaches them
   * through a symbolic link that leaves the workspace.
   *
   * Bubblewrap needs them because it replaces `/tmp` with a private tmpfs, so
   * a link into the host's `/tmp` (the scratch tree's `node_modules`, which
   * points back at the real workspace) resolves to nothing inside the sandbox.
   * Binding the real location read-only makes the link resolve to the same
   * bytes the host sees, which is what declaring the read asked for. Docker
   * mounts them for the same reason: the image supplies everything outside
   * the workspace, and these paths are on the host. Seatbelt leaves the host
   * filesystem in place and needs no second spelling. The request's own
   * `externalReads` land here too.
   */
  readonly externalReads: ReadonlyArray<string>
  /** A host directory the run may scribble in; created by the caller, removed after. */
  readonly tmp: string
  readonly uid: number | undefined
  readonly gid: number | undefined
}

/**
 * Resolves the network posture of an explicit policy. Service dependencies do
 * not widen it; their consumers must declare the network access they need.
 *
 * The policy `"none"` resolves to the `"open"` posture, which reads as a
 * contradiction only until the two vocabularies are separated: a target that
 * declared no sandbox is not confined, and an unconfined process has the
 * host's network.
 *
 * @category resolution
 * @since 0.1.0
 */
export const network = (policy: Policy | undefined): Network => {
  if (policy === "none") return "open"
  if (typeof policy === "object" && policy !== null) {
    if (policy.network === true) return "open"
    if (policy.network === "loopback") return "loopback"
  }
  return "none"
}

const pathSeparator = (platform: NodeJS.Platform): string => platform === "win32" ? ";" : ":"

/**
 * The real host: platform, `PATH` lookup, and filesystem probes.
 *
 * @category resolution
 * @since 0.1.0
 */
export const host = (env: Readonly<Record<string, string | undefined>> = process.env): Host => {
  const platform = process.platform
  const entries = (env["PATH"] ?? "").split(pathSeparator(platform)).filter((entry) => entry !== "")
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""]
  return {
    platform,
    executable: (name) => {
      if (NodePath.isAbsolute(name)) return isExecutable(name) ? name : undefined
      for (const entry of entries) {
        for (const extension of extensions) {
          const candidate = NodePath.join(entry, name + extension)
          if (isExecutable(candidate)) return candidate
        }
      }
      return undefined
    },
    exists: (path) => NodeFs.existsSync(path),
    isDirectory: (path) => {
      try {
        return NodeFs.statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    entries: (directory) => {
      try {
        return NodeFs.readdirSync(directory)
      } catch {
        return undefined
      }
    },
    realpath: (path) => {
      try {
        return NodeFs.realpathSync(path)
      } catch {
        return undefined
      }
    },
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined
  }
}

const isExecutable = (path: string): boolean => {
  try {
    NodeFs.accessSync(path, NodeFs.constants.X_OK)
    return NodeFs.statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Selects the mechanism a request runs under on a host.
 *
 * A `"none"` policy or a `Sandbox.None()` declaration selects nothing. A
 * declared mechanism is honored or refused; with no declaration the platform
 * decides: bubblewrap on Linux, seatbelt on macOS, and a refusal elsewhere,
 * because Windows has no user-level process sandbox and Docker needs an image
 * only the workspace can name.
 *
 * @category resolution
 * @since 0.1.0
 */
export const select = (request: Request, hostFacts: Host): Mechanism | Unenforceable => {
  if (request.policy === "none") return { _tag: "none" }
  const declared = request.mechanism
  const platform = hostFacts.platform
  if (declared !== undefined && declared._tag === "SandboxNone") return { _tag: "none" }
  if (declared !== undefined && declared._tag === "SandboxMicrosandbox") {
    return unenforceable(
      platform,
      "microsandbox",
      "S.Sandbox.Bubblewrap",
      "S.Sandbox.Microsandbox is the runtime sandbox (@smthrs/sandbox MicrosandboxSandbox) for agent and flow sessions; " +
        "build-target confinement runs under S.Sandbox.Bubblewrap or S.Sandbox.Docker"
    )
  }
  if (declared !== undefined && declared._tag === "SandboxDocker") {
    const executable = hostFacts.executable("docker")
    if (executable === undefined) {
      return unenforceable(platform, "docker", "docker", "S.Sandbox.Docker is declared but docker is not on PATH")
    }
    return { _tag: "docker", executable, image: declared.image }
  }
  if (declared !== undefined && declared._tag === "SandboxBubblewrap" && platform !== "linux") {
    return unenforceable(
      platform,
      "bubblewrap",
      "linux",
      "S.Sandbox.Bubblewrap is declared but bubblewrap runs only on Linux; on macOS the seatbelt mechanism is selected when no mechanism is declared"
    )
  }
  if (platform === "linux") {
    const executable = hostFacts.executable("bwrap")
    if (executable === undefined) {
      return unenforceable(platform, "bubblewrap", "bwrap", "bwrap is not on PATH (install the bubblewrap package)")
    }
    if (network(request.policy) === "loopback") {
      return unenforceable(
        platform,
        "bubblewrap",
        "network: true",
        "bubblewrap cannot expose only the host loopback interface: sharing that interface also grants full host networking; " +
          "declare sandbox: { network: true } to opt into that access"
      )
    }
    return { _tag: "bubblewrap", executable }
  }
  if (platform === "darwin") {
    const executable = hostFacts.executable("/usr/bin/sandbox-exec")
    if (executable === undefined) {
      return unenforceable(platform, "seatbelt", "/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec is missing")
    }
    return { _tag: "seatbelt", executable }
  }
  return unenforceable(
    platform,
    "docker",
    "S.Sandbox.Docker",
    `${platform} has no process sandbox of its own; declare S.Sandboxes({ default: S.Sandbox.Docker({ image }) })`
  )
}

/**
 * Whether a request would be enforced on a host: the policy opts out, or a
 * mechanism is available. A confined request with no mechanism is not
 * enforced, and execution fails it closed.
 *
 * @category resolution
 * @since 0.1.0
 */
export const enforceable = (request: Request, hostFacts: Host): boolean => {
  const selected = select(request, hostFacts)
  return !isUnenforceable(selected) && selected._tag !== "none"
}

const toPosix = (path: string): string => path.split(NodePath.sep).join("/")

/**
 * The path with the symlinks of its existing ancestors resolved. A path that
 * does not exist yet keeps its unresolved tail below the deepest ancestor
 * that does; a path with no existing ancestor is returned as given.
 */
const realized = (path: string): string => {
  let head = path
  const tail: Array<string> = []
  while (head !== NodePath.dirname(head)) {
    try {
      const real = NodeFs.realpathSync(head)
      return tail.length === 0 ? real : NodePath.join(real, ...tail)
    } catch {
      tail.unshift(NodePath.basename(head))
      head = NodePath.dirname(head)
    }
  }
  return path
}

const insideRoot = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/**
 * Folds a declared file set into directories plus the entries to re-close.
 *
 * The seatbelt compiler caps one rule's data at 64 KiB, so a workspace with a
 * few thousand declared sources cannot be granted file by file. Deepest
 * first, a directory in which at least as many entries are covered as not is
 * granted whole, and its uncovered entries are listed for a deny rule that
 * follows the grant. The result admits exactly the declared set plus the
 * granted directories' future entries. A directory whose uncovered entry
 * still holds declared files deeper down is never folded over that entry,
 * the workspace root is never folded, and a host that cannot list a
 * directory leaves its files as they were. Covered means a declared read, a
 * declared write, or the private tmp.
 */
const fold = (
  root: string,
  declared: ReadonlyArray<string>,
  alsoCovered: ReadonlyArray<string>,
  hostFacts: Host
): { readonly reads: ReadonlyArray<string>; readonly denies: ReadonlyArray<string> } => {
  const entries = hostFacts.entries
  if (entries === undefined) return { reads: declared, denies: [] }
  const covered = new Set([...declared, ...alsoCovered])
  const candidates = new Set<string>()
  for (const path of declared) {
    let current = NodePath.dirname(path)
    while (insideRoot(root, current) && current !== root && !candidates.has(current)) {
      candidates.add(current)
      current = NodePath.dirname(current)
    }
  }
  const deepestFirst = [...candidates].sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
  const promoted: Array<string> = []
  const denies: Array<string> = []
  for (const directory of deepestFirst) {
    if (covered.has(directory)) continue
    const children = entries(directory)
    if (children === undefined || children.length === 0) continue
    const uncovered: Array<string> = []
    let coveredCount = 0
    let partial = false
    for (const child of children) {
      const path = NodePath.join(directory, child)
      if (covered.has(path)) coveredCount += 1
      else if (candidates.has(path)) partial = true
      else uncovered.push(path)
    }
    if (partial || coveredCount === 0 || coveredCount < uncovered.length) continue
    covered.add(directory)
    promoted.push(directory)
    denies.push(...uncovered)
  }
  return { reads: [...declared, ...promoted], denies }
}

/** Drops a path covered by another entry of the same set, keeping the set ordered. */
const collapse = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || (left < right ? -1 : 1))
  const kept: Array<string> = []
  for (const path of sorted) {
    if (kept.some((parent) => parent === path || path.startsWith(parent + NodePath.sep))) continue
    kept.push(path)
  }
  return kept
}

/**
 * Resolves a request against a workspace into a {@link Plan}, or refuses.
 *
 * Every relative path is anchored at the canonical workspace root; one that
 * escapes the workspace is dropped, because the sandbox never grants anything
 * outside the tree the key covers. Reads that do not exist are dropped too:
 * bubblewrap cannot bind a missing path, and a declared input that vanished is
 * the executor's measurement failure, not this module's.
 *
 * @category resolution
 * @since 0.1.0
 */
export const plan = (
  request: Request,
  location: { readonly workspaceRoot: string; readonly cwd: string; readonly tmp: string },
  hostFacts: Host
): Plan | Unenforceable | undefined => {
  const selected = select(request, hostFacts)
  if (isUnenforceable(selected)) return selected
  if (selected._tag === "none") return undefined
  const root = location.workspaceRoot
  const anchor = (relative: string): string | undefined => {
    const absolute = NodePath.resolve(root, ...relative.split("/"))
    return insideRoot(root, absolute) ? absolute : undefined
  }
  const declared: Array<string> = []
  // A declared read that is a link out of the workspace is admitted at both
  // spellings: the path the tool opens, and the place the bytes live. Only
  // bubblewrap renders the second one, because only bubblewrap hides the
  // host's `/tmp` (the scratch tree's `node_modules` points back at the real
  // workspace, and a fixture workspace under `os.tmpdir()` points nowhere
  // else); seatbelt and docker leave the host filesystem in place.
  const externalReads: Array<string> = []
  for (const relative of request.reads) {
    const absolute = anchor(relative)
    if (absolute === undefined || !hostFacts.exists(absolute)) continue
    declared.push(absolute)
    const real = hostFacts.realpath?.(absolute)
    if (real !== undefined && real !== absolute && !insideRoot(root, real)) externalReads.push(real)
  }
  for (const path of request.externalReads ?? []) {
    if (!NodePath.isAbsolute(path) || insideRoot(root, path) || !hostFacts.exists(path)) continue
    externalReads.push(hostFacts.realpath?.(path) ?? path)
  }
  // A write names a directory the tool may fill, and is bound as declared
  // whether or not it exists yet: a name is never read as a file, because a
  // dot in `.cargo-home` or `dist.new` would otherwise widen the bind to the
  // parent, and a parent that is the workspace root opens every file in it.
  // A path that is already a file on the host is the one exception, since a
  // file cannot be bound as a writable directory.
  const writes: Array<string> = []
  const add = (absolute: string | undefined): void => {
    if (absolute === undefined || !insideRoot(root, absolute)) return
    writes.push(absolute)
  }
  for (const relative of request.writes) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    add(hostFacts.exists(absolute) && !hostFacts.isDirectory(absolute) ? NodePath.dirname(absolute) : absolute)
  }
  // A declared output file opens its parent: a file cannot be bound before it
  // exists, and a tool that writes by rename needs the directory anyway.
  for (const relative of request.writeFiles ?? []) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    add(hostFacts.exists(absolute) && hostFacts.isDirectory(absolute) ? absolute : NodePath.dirname(absolute))
  }
  const readOnly: Array<string> = []
  for (const relative of request.readOnly ?? []) {
    const absolute = anchor(relative)
    if (absolute !== undefined) readOnly.push(absolute)
  }
  const folded = selected._tag === "seatbelt"
    ? fold(root, declared, [...writes, ...readOnly, location.tmp], hostFacts)
    : { reads: declared, denies: [] }
  return {
    mechanism: selected,
    network: network(request.policy),
    workspaceRoot: root,
    cwd: location.cwd,
    reads: collapse(folded.reads),
    readDenies: collapse(folded.denies),
    writes: collapse(writes),
    readOnly: collapse(readOnly),
    externalReads: collapse(externalReads),
    tmp: location.tmp,
    uid: hostFacts.uid,
    gid: hostFacts.gid
  }
}

/**
 * Where corepack keeps the package-manager binaries it manages, resolved the
 * way corepack itself resolves it from a host environment.
 *
 * A `pnpm`, `yarn`, or `npm` on `PATH` is often corepack's shim, and the
 * program it execs lives in this directory, not on `PATH`. Redirecting `HOME`
 * and `XDG_CACHE_HOME` to the private tmp moves that directory out from under
 * the shim, which then tries to re-download the package manager from the
 * registry — and a confined run has no network, so every rule that drives the
 * package manager fails with a connect error that names the registry rather
 * than the missing cache.
 */
const corepackHome = (env: Readonly<Record<string, string | undefined>>, home: string): string => {
  const declared = env["COREPACK_HOME"]
  if (declared !== undefined && declared !== "") return declared
  const base = env["XDG_CACHE_HOME"] ?? env["LOCALAPPDATA"] ??
    NodePath.join(home, process.platform === "win32" ? "AppData/Local" : ".cache")
  return NodePath.join(base, "node", "corepack")
}

/**
 * Environment the confined process receives on top of the tool environment:
 * a private temporary directory and home, so nothing a tool caches lands in
 * the real home or the shared temp directory.
 *
 * `COREPACK_HOME` is the one host cache kept: it holds the package-manager
 * program a corepack shim execs, the run may only read it (the mechanisms
 * deny writes outside the workspace), and without it a confined `pnpm` is a
 * shim with nothing to run.
 *
 * @category rendering
 * @since 0.1.0
 */
export const environment = (
  confinement: Plan,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
  hostHome: string = NodeOs.homedir()
): Readonly<Record<string, string>> => {
  const tmp = confinement.mechanism._tag === "seatbelt" ? confinement.tmp : "/tmp"
  const home = NodePath.posix.join(toPosix(tmp), "home")
  return {
    COREPACK_HOME: corepackHome(hostEnv, hostHome),
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: NodePath.posix.join(toPosix(tmp), "cache")
  }
}

/**
 * The bubblewrap argv for a plan.
 *
 * Order matters: bubblewrap applies operations in argument order, so the
 * read-only root goes first, the workspace tmpfs shadows it, declared paths
 * are bound on top, re-closed subtrees are bound read-only over their writable
 * parents, and the tmpfs is remounted read-only last so an undeclared write
 * under the workspace fails with `EROFS` instead of vanishing into the tmpfs.
 *
 * @category rendering
 * @since 0.1.0
 */
export const bubblewrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "bubblewrap") throw new Error("bubblewrap argv needs a bubblewrap plan")
  const home = "/tmp/home"
  const out: Array<string> = [
    confinement.mechanism.executable,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    home,
    "--dir",
    "/tmp/cache",
    "--tmpfs",
    confinement.workspaceRoot
  ]
  // The target of a link that leaves the workspace is bound first, so the
  // link a declared read then binds resolves to the same bytes the host sees
  // even when `/tmp` above the target has just become a private tmpfs.
  for (const real of confinement.externalReads) out.push("--ro-bind", real, real)
  for (const read of confinement.reads) out.push("--ro-bind", read, read)
  for (const write of confinement.writes) out.push("--bind", write, write)
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + NodePath.sep))) {
      out.push("--ro-bind-try", closed, closed)
    }
  }
  // `--remount-ro` acts on the mount at that exact path. When the root itself
  // is a declared write (a declared output file at the top level opens its
  // parent), that mount is the writable bind, and remounting it would deny
  // every write the declaration admitted; the tmpfs it replaced needs no
  // re-closing.
  if (!confinement.writes.includes(confinement.workspaceRoot)) out.push("--remount-ro", confinement.workspaceRoot)
  out.push("--chdir", confinement.cwd, "--unshare-all", "--new-session", "--die-with-parent")
  // Bubblewrap cannot expose only the host loopback interface. Planning
  // refuses that posture on Linux, so only an explicit full-network opening
  // reaches `--share-net` here.
  if (confinement.network === "loopback") {
    throw new Error("bubblewrap cannot render loopback-only networking")
  }
  if (confinement.network === "open") out.push("--share-net")
  out.push("--", ...argv)
  return out
}

/** Escapes one string for a seatbelt profile literal. */
const sbpl = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`

/** Every directory from the workspace root down to the parent of each path. */
const ancestors = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Set<string>([root])
  for (const path of paths) {
    let current = NodePath.dirname(path)
    while (current.length >= root.length && current !== NodePath.dirname(current)) {
      found.add(current)
      if (current === root) break
      current = NodePath.dirname(current)
    }
  }
  return [...found].sort()
}

/**
 * The seatbelt profile for a plan.
 *
 * Later rules win, so the profile opens everything, closes the network and
 * the writes, closes reads under the workspace, then reopens exactly the
 * declared set. Reads outside the workspace stay open: the loader, the
 * interpreters, and the package manager live there, and the workspace tree is
 * what the content key covers.
 *
 * @category rendering
 * @since 0.1.0
 */
export const seatbelt = (confinement: Plan): string => {
  if (confinement.mechanism._tag !== "seatbelt") throw new Error("a seatbelt profile needs a seatbelt plan")
  const lines: Array<string> = ["(version 1)", "(allow default)"]
  if (confinement.network !== "open") {
    lines.push("(deny network*)", "(allow network* (local unix-socket))")
    if (confinement.network === "loopback") {
      lines.push(
        "(allow network-bind (local ip \"localhost:*\"))",
        "(allow network-inbound (local ip \"localhost:*\"))",
        "(allow network-outbound (remote ip \"localhost:*\"))"
      )
    }
  }
  const writable = [...confinement.writes, confinement.tmp]
  lines.push(
    "(deny file-write*)",
    `(allow file-write* (subpath "/dev") ${writable.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`
  )
  if (confinement.readOnly.length > 0) {
    lines.push(`(deny file-write* ${confinement.readOnly.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  const readable = [...confinement.reads, ...confinement.writes, confinement.tmp]
  const listable = ancestors(
    confinement.workspaceRoot,
    readable.filter((path) => insideRoot(confinement.workspaceRoot, path))
  )
  lines.push(
    `(deny file-read* (subpath ${sbpl(confinement.workspaceRoot)}))`,
    `(allow file-read-metadata (subpath ${sbpl(confinement.workspaceRoot)}))`,
    `(allow file-read* ${listable.map((path) => `(literal ${sbpl(path)})`).join(" ")} ${
      readable.map((path) => `(subpath ${sbpl(path)})`).join(" ")
    })`
  )
  if (confinement.readDenies.length > 0) {
    lines.push(`(deny file-read* ${confinement.readDenies.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  return lines.join("")
}

/**
 * The `docker run` argv for a plan. Paths keep their host spelling inside the
 * container so an argv that names workspace paths works unchanged; the image
 * supplies everything outside the workspace.
 *
 * @category rendering
 * @since 0.1.0
 */
export const docker = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "docker") throw new Error("docker argv needs a docker plan")
  const out: Array<string> = [
    confinement.mechanism.executable,
    "run",
    "--rm",
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec",
    "--network",
    confinement.network === "open" ? "bridge" : "none",
    "--workdir",
    toPosix(confinement.cwd)
  ]
  if (confinement.uid !== undefined && confinement.gid !== undefined) {
    out.push("--user", `${confinement.uid}:${confinement.gid}`)
  }
  for (const real of confinement.externalReads) {
    out.push("--mount", `type=bind,src=${real},dst=${toPosix(real)},readonly`)
  }
  for (const read of confinement.reads) out.push("--mount", `type=bind,src=${read},dst=${toPosix(read)},readonly`)
  for (const write of confinement.writes) out.push("--mount", `type=bind,src=${write},dst=${toPosix(write)}`)
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + NodePath.sep))) {
      out.push("--mount", `type=bind,src=${closed},dst=${toPosix(closed)},readonly`)
    }
  }
  for (const [name, value] of Object.entries(env).sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (name === "PATH" || name === "HOME") continue
    out.push("--env", `${name}=${value}`)
  }
  out.push("--env", "HOME=/tmp/home", confinement.mechanism.image, ...argv)
  return out
}

/**
 * Wraps a tool argv in the plan's mechanism and reports the environment the
 * wrapper needs the child to carry.
 *
 * @category rendering
 * @since 0.1.0
 */
export const wrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>
): { readonly argv: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> } => {
  const extra = environment(confinement)
  switch (confinement.mechanism._tag) {
    case "bubblewrap":
      return { argv: bubblewrap(confinement, argv), env: extra }
    case "seatbelt": {
      const profile = seatbelt(confinement)
      return { argv: [confinement.mechanism.executable, "-p", profile, ...argv], env: extra }
    }
    case "docker":
      return { argv: docker(confinement, argv, { ...env, ...extra }), env: {} }
  }
}

/**
 * Each pattern names the path a tool complained about and whether the text
 * proves the denied operation was a write. A confined process never sees an
 * undeclared path: seatbelt answers EPERM, bubblewrap answers ENOENT because
 * the path was never mounted, and dash spells that "Directory nonexistent".
 */
const denialPatterns: ReadonlyArray<{ readonly pattern: RegExp; readonly write: boolean }> = [
  { pattern: /\b(?:EACCES|EPERM|ENOENT)\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: false },
  { pattern: /\bEROFS\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: true },
  {
    pattern:
      /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): (?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent|Not a directory)/gm,
    write: false
  },
  { pattern: /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): Read-only file system/gm, write: true },
  {
    pattern:
      /(?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent)[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g,
    write: false
  },
  { pattern: /Read-only file system[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g, write: true },
  {
    pattern: /cannot (?:create|write|touch|mkdir|remove) (?:directory )?['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g,
    write: true
  },
  { pattern: /cannot (?:open|access|stat|read) ['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g, write: false }
]

/**
 * Names, from a failed tool's own output, the paths it touched outside the
 * declared set. The sandbox denies at the kernel, so the only witness is the
 * tool's error text; this reads it back and says which side of the boundary
 * each path fell on.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const diagnose = (confinement: Plan, text: string): string | undefined => {
  // Path → whether the text proved the denied operation was a write.
  const named = new Map<string, boolean>()
  for (const { pattern, write } of denialPatterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]
      if (raw === undefined) continue
      const absolute = NodePath.isAbsolute(raw) ? raw : NodePath.resolve(confinement.cwd, raw)
      if (insideRoot(confinement.workspaceRoot, absolute)) named.set(absolute, (named.get(absolute) ?? false) || write)
      if (named.size >= 5) break
    }
    if (named.size >= 5) break
  }
  if (named.size === 0) return undefined
  const covered = (path: string, set: ReadonlyArray<string>): boolean =>
    set.some((entry) => entry === path || path.startsWith(entry + NodePath.sep))
  const lines = [...named.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, write]) => {
    const relative = toPosix(NodePath.relative(confinement.workspaceRoot, path))
    // A path that lexically sits in the workspace can still leave it through
    // a symlink in an existing ancestor; the declaration covers the tree, not
    // wherever a link points.
    const real = realized(path)
    const escapes = !insideRoot(confinement.workspaceRoot, real)
    const readable = !escapes && (covered(path, confinement.reads) || covered(path, confinement.writes))
    const writable = !escapes && covered(path, confinement.writes) && !covered(path, confinement.readOnly)
    if (escapes) {
      return `sandbox: ${relative} resolves to ${real}, outside the declared ${write ? "write" : "read"} set`
    }
    if (write) {
      return writable
        ? `sandbox: ${relative} was denied inside the declared set`
        : `sandbox: ${relative} is outside the declared write set`
    }
    if (!readable) return `sandbox: ${relative} is outside the declared read set`
    if (!writable) return `sandbox: ${relative} is outside the declared write set`
    return `sandbox: ${relative} was denied inside the declared set`
  })
  return `${lines.join("\n")}\nsandbox: ${confinement.mechanism._tag}, network ${confinement.network}, ` +
    `${confinement.reads.length} read path(s), ${confinement.writes.length} write path(s)`
}
