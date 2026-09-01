/**
 * Lazy BUILD.ts discovery, workspace configuration resolution, declared-input
 * expansion, and default-target target synthesis.
 *
 * @since 0.1.0
 */
import * as Config from "@smthrs/targets/Config"
import { isFilegroup } from "@smthrs/targets/Filegroup"
import { writeGeneratedFile } from "@smthrs/targets/GeneratedFile"
import * as Input from "@smthrs/targets/Input"
import * as PackageDefaults from "@smthrs/targets/PackageDefaults"
import * as PackageJson from "@smthrs/targets/PackageJson"
import * as RemoteCache from "@smthrs/targets/RemoteCache"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { execFile } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { buildModuleUrl, importDeclarationModule, installEffectResolution } from "./effect-resolution.js"
import * as Label from "./Label.ts"

// Workspace is also imported as a library by tests and embedding hosts that do
// not pass through main.js. BUILD.ts loading must carry the same single-Effect
// invariant in every entry point.
installEffectResolution()

/**
 * A file and the digest that contributes to target key material.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type FileDigest = Input.FileDigest

/**
 * One declared matcher after discovery and content measurement.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExpandedInput {
  readonly declaration: Input.Declared
  readonly files: ReadonlyArray<FileDigest>
  readonly digest: string
}

/**
 * A BUILD.ts module after its named target exports are indexed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BuildModule {
  readonly file: string
  readonly targets: ReadonlyMap<string, Target.AnyTarget>
  readonly defaults: ReadonlyArray<PackageDefaults.PackageDefaults>
}

/**
 * A discovered default-target declaration and the package that declared it.
 *
 * The declaring package anchors the declaration's directory glob.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PackageDefaultsEntry {
  readonly declaration: PackageDefaults.PackageDefaults
  readonly packagePath: string
}

const posix = (value: string): string => value.split(NodePath.sep).join("/")

/**
 * Orders strings by UTF-16 code unit. `localeCompare` answers differently
 * under different host locales and ICU versions, which would let one workspace
 * pick a different configuration declaration, or synthesize targets in a
 * different order, on two machines looking at the same files; code-unit order
 * is the same everywhere.
 */
const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * The most a git listing may produce.
 *
 * A workspace larger than this is not silently truncated: `execFile` fails the
 * command with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, and that failure is
 * reported rather than answered by the filesystem fallback, because a
 * truncated listing and a complete one are indistinguishable afterwards.
 */
const gitMaxBuffer = 64 * 1024 * 1024

/** Hard limits for one Git subprocess and the path records it returns. */
const gitTimeoutMs = 30_000
const gitPathLimit = 500_000
const gitPathBytes = 16 * 1024

/**
 * Maximum bytes accepted from the root `.gitignore` before an update.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumGitignoreBytes = 16 * 1024 * 1024

/** One failed git invocation, described well enough to decide what to do. */
interface GitFailure {
  readonly code: string | undefined
  readonly status: number | undefined
  readonly stderr: string
}

const failures = new WeakMap<Error, GitFailure>()

const runGit = (
  root: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal | undefined
): Promise<string> =>
  new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PAGER: "cat"
    }
    const decode = (bytes: Buffer | string, what: string): string => {
      try {
        if (typeof bytes === "string") {
          if (!bytes.isWellFormed()) throw new Error("unpaired surrogate")
          return bytes
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new Error(`git ${args.join(" ")} returned ${what} that is not valid UTF-8`)
      }
    }
    try {
      execFile(
        "git",
        [...args],
        {
          cwd: root,
          encoding: "buffer",
          env: environment,
          killSignal: "SIGKILL",
          maxBuffer: gitMaxBuffer,
          signal,
          timeout: gitTimeoutMs,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          let standardError: string
          try {
            standardError = decode(stderr, "stderr").trim()
          } catch (cause) {
            reject(cause)
            return
          }
          if (error === null) {
            try {
              resolve(decode(stdout, "stdout"))
            } catch (cause) {
              reject(cause)
            }
            return
          }
          const reported = new Error(
            `git ${args.join(" ")} failed${standardError === "" ? `: ${error.message}` : `: ${standardError}`}`
          )
          failures.set(reported, {
            code: typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : undefined,
            status: typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : undefined,
            stderr: standardError
          })
          reject(reported)
        }
      )
    } catch (cause) {
      reject(cause)
    }
  })

/** Parses exact `-z` framing without allocating an unbounded split array. */
const nulPaths = (output: string): ReadonlyArray<string> => {
  if (output === "") return []
  const paths: Array<string> = []
  let start = 0
  while (start < output.length) {
    const end = output.indexOf("\0", start)
    if (end < 0) throw new Error("git returned a path listing without its final NUL delimiter")
    const path = output.slice(start, end)
    if (path === "") throw new Error("git returned an empty path record")
    if (Buffer.byteLength(path, "utf8") > gitPathBytes) {
      throw new Error(`git listed a path longer than ${gitPathBytes} bytes`)
    }
    paths.push(path)
    if (paths.length > gitPathLimit) throw new Error(`git listed more than ${gitPathLimit} paths`)
    start = end + 1
  }
  return paths
}

/**
 * Reports whether a git failure is one the filesystem fallback answers
 * completely.
 *
 * Exactly two cases qualify, and both mean git had nothing to say about this
 * directory in the first place:
 *
 * - git could not be run at all, because it is not installed or not
 *   executable, and
 * - the directory is not inside a git worktree.
 *
 * A walk of the tree is a complete answer to both. Every other failure —
 * a repository this process cannot read, an object-store corruption, a listing
 * too large for the subprocess buffer, a git that was killed — is reported.
 * Falling back on those would hide a real fault behind a listing that looks
 * fine but is missing files, and a workspace missing files plans and caches as
 * if those files were deleted.
 */
const fallbackApplies = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false
  const failure = failures.get(cause as Error)
  if (failure === undefined) return false
  if (failure.code === "ENOENT" || failure.code === "EACCES") return true
  return failure.status === 128 && /not a git repository|not a working tree/i.test(failure.stderr)
}

/**
 * Reports whether one path from a git listing is a workspace-relative path
 * discovery may join to the workspace root.
 *
 * git reports paths as bytes relative to the repository root, and `-z` output
 * is never quoted, so anything absolute, rooted, traversing, or empty is not
 * something git found in this workspace. Joining such a value to the root
 * would let a listing name a file outside the workspace and have it digested,
 * imported as a `BUILD.ts`, or both.
 *
 * A backslash is refused because it is a path separator on some hosts: the
 * same listing would then mean two different files depending on where it was
 * read. A NUL cannot appear in a path and marks output that was framed wrong.
 *
 * @category validation
 * @since 0.1.0
 * @slop
 */
export const isGitPath = (path: string): boolean => {
  if (path === "" || path.includes("\0") || path.includes("\\")) return false
  if (path.startsWith("/") || NodePath.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

const fixedStoreDirectory = `${Config.defaultCacheDirectory}/store`

/**
 * Reports whether a workspace-relative path is inside replayable host state.
 * This includes the resolved cache directory and the fixed install store.
 */
const inWorkspaceStateDirectory = (cacheDirectory: string, path: string): boolean =>
  path === cacheDirectory ||
  path.startsWith(`${cacheDirectory}/`) ||
  path === fixedStoreDirectory ||
  path.startsWith(`${fixedStoreDirectory}/`)

/**
 * Validates one raw git listing, drops empty entries and host state, and
 * sorts. Every git listing that reaches a path join goes through this.
 */
const gitPaths = (
  files: ReadonlyArray<string>,
  cacheDirectory: string
): ReadonlyArray<string> => {
  const kept: Array<string> = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file.length === 0) continue
    if (!isGitPath(file)) {
      throw new Error(`git listed a path the workspace cannot use: ${JSON.stringify(file)}`)
    }
    if (Buffer.byteLength(file, "utf8") > gitPathBytes) {
      throw new Error(`git listed a path longer than ${gitPathBytes} bytes`)
    }
    if (inWorkspaceStateDirectory(cacheDirectory, file)) continue
    if (seen.has(file)) throw new Error(`git listed one path more than once: ${JSON.stringify(file)}`)
    seen.add(file)
    kept.push(file)
    if (kept.length > gitPathLimit) throw new Error(`git listed more than ${gitPathLimit} paths`)
  }
  return kept.sort(byCodeUnit)
}

/**
 * Reduces a git listing to the paths discovery may see.
 *
 * Empty entries, `node_modules` content, the cache directory, and the fixed
 * install store are dropped, and the result is sorted by UTF-16 code unit.
 * Host state is dropped even when git lists it because the workspace does not
 * ignore it: replayable content must never reach input discovery or a digest.
 *
 * Every remaining entry must be a path {@link isGitPath} accepts. A listing
 * that names an absolute or traversing path is not filtered down to the safe
 * part of itself; the whole listing fails, because a listing that framed one
 * entry wrong is not a listing to trust the rest of.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const discoverable = (
  files: ReadonlyArray<string>,
  cacheDirectory: string
): ReadonlyArray<string> => gitPaths(files, cacheDirectory).filter((file) => !file.split("/").includes("node_modules"))

/**
 * Lists the workspace, preferring git and falling back to a walk only when git
 * had nothing to say.
 *
 * @see {@link fallbackApplies} for which failures the fallback may answer.
 */
const workspaceFiles = async (
  root: string,
  cacheDirectory: string,
  signal?: AbortSignal | undefined
): Promise<ReadonlyArray<string>> => {
  let output: string
  try {
    output = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal)
  } catch (cause) {
    if (!fallbackApplies(cause)) throw cause
    return Input.discoverFiles(root, { cacheDirectory, signal })
  }
  return discoverable(nulPaths(output), cacheDirectory)
}

const namespaces = new Map<string, Promise<unknown>>()

/**
 * Identifies one BUILD.ts module by the file it is, not by the name it was
 * reached under.
 *
 * The cache is process-global, and a library caller runs more than one command
 * in one process. Keying it on a path string alone was wrong twice over. Two
 * different workspaces reached through different mounts, symlink farms, or
 * `..`-relative spellings can produce the same string for different files, and
 * would then have shared one module and one set of target identities. And a
 * `BUILD.ts` edited between two commands in the same process kept its path, so
 * the second command replayed the first command's declarations against the
 * new file's inputs.
 *
 * The path is canonical, which merges two spellings of one file, and a
 * descriptor-stable SHA-256 of its bytes detects an edit even when a writer
 * preserves its size and modification time. Within one command the digest does
 * not move, so configuration
 * discovery and target loading still share one evaluation and the target
 * values it exports keep one identity — which is what the planner matches a
 * dependency to its label by.
 */
const moduleKey = async (entry: SafeFs.Entry): Promise<string> => {
  const digest = await SafeFs.digestFile(entry.path, { what: "BUILD.ts" })
  if (digest === undefined) throw new Error(`BUILD.ts no longer exists: ${entry.path}`)
  return `${entry.path}\0${digest}`
}

/**
 * Admits one BUILD.ts file, or reports that the package has none.
 *
 * A probe used to be `stat(path).then((stats) => stats.isFile()).catch(() => false)`,
 * which answered "there is no BUILD.ts here" for a file this process could not
 * read, for a directory, and for a FIFO, and which followed a symbolic link
 * wherever it pointed. A workspace could therefore lose its configuration
 * silently, or import a module from outside itself through a link it contains.
 *
 * A `BUILD.ts` is admitted when it resolves, inside the canonical workspace
 * root, to a regular file. A link out of the workspace is refused by name, and
 * an unreadable or unsupported entry fails rather than reading as absence.
 */
const buildEntry = (
  root: string,
  relative: string
): Promise<SafeFs.Entry | undefined> => SafeFs.resolveFile(NodePath.join(root, relative), { root, what: "BUILD.ts" })

/**
 * Imports one BUILD.ts module through tsx's programmatic loader, at most once
 * per file.
 *
 * ## Trust boundary
 *
 * A BUILD.ts file is executable TypeScript evaluated in this process. It can
 * import any host module, read any file the user can read, and spawn any
 * process. Evaluating one is exactly as trusted as running the repository's
 * own code: a workspace you would not run `pnpm install` in is a workspace you
 * must not point this CLI at.
 *
 * Root declaration modules were once imported with `process.env` emptied and
 * restored around the import. That hid nothing, because a module that wants
 * the environment can read `/proc/self/environ` or spawn a child, and it
 * corrupted state the CLI does not own: a concurrent command or any unrelated
 * code in the host process saw an empty environment for the duration of the
 * import and lost every variable it set during it. Credentials are withheld at
 * the boundary that is real, the child-process edge in `ExecLive`, and token
 * values never enter declaration or target key material.
 */
const importNamespace = async (entry: SafeFs.Entry): Promise<unknown> => {
  const key = await moduleKey(entry)
  const existing = namespaces.get(key)
  if (existing !== undefined) return existing
  const loaded = importDeclarationModule(buildModuleUrl(pathToFileURL(entry.path).href), import.meta.url)
  namespaces.set(key, loaded)
  return loaded
}

/**
 * The cache-directory settings one command runs under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ResolvedConfig {
  readonly cacheDirectory: string
  readonly gitignored: boolean
}

const declaredConfig = (namespace: unknown): Config.Workspace | undefined => {
  if (typeof namespace !== "object" || namespace === null) return undefined
  for (const [, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
    if (Config.isWorkspace(value)) return value
  }
  return undefined
}

const declaredRemoteCache = (namespace: unknown): RemoteCache.RemoteCache | undefined => {
  if (typeof namespace !== "object" || namespace === null) return undefined
  for (const [, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
    if (RemoteCache.isRemoteCache(value)) return value
  }
  return undefined
}

/**
 * Resolves the cache directory a command runs under.
 *
 * Precedence is the `--cache-dir` flag, then the {@link Config} value exported
 * from the root BUILD.ts file, then `.flows`. `gitignored` comes only from the
 * declaration, because it is a workspace policy rather than a per-run choice.
 * Both the flag and the declaration are validated, so an absolute path, a
 * parent traversal, or an empty value fails the command.
 *
 * The root BUILD.ts is admitted by {@link buildEntry}, so a file this process
 * cannot read fails the command instead of quietly resolving to the default
 * cache directory.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const resolveConfig = async (
  root: string,
  override?: string | undefined
): Promise<ResolvedConfig> => {
  const canonical = await SafeFs.canonicalRoot(root)
  const entry = await buildEntry(canonical, "BUILD.ts")
  const declaration = entry === undefined ? undefined : declaredConfig(await importNamespace(entry))
  const declared = declaration ?? Config.Workspace()
  return {
    cacheDirectory: Config.normalizeCacheDirectory(override ?? declared.cacheDirectory),
    gitignored: declared.gitignored
  }
}

/**
 * Which credentials a workspace declared for its remote cache.
 *
 * A remote build cache has untrusted readers and trusted writers: every job
 * pulls, and only a job whose inputs were reviewed may publish. `split` is
 * that posture. `shared` is one credential doing both jobs, which is what a
 * deployment that has not separated its secrets yet has, and it is a tag
 * rather than an absent field so no caller can read the single-credential case
 * as an oversight.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ResolvedRemoteCacheCredentials =
  | { readonly _tag: "shared"; readonly tokenEnv: string }
  | { readonly _tag: "split"; readonly readTokenEnv: string; readonly writeTokenEnv: string }

/**
 * The remote-cache settings one command runs under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ResolvedRemoteCache {
  readonly endpoint: string
  readonly credentials: ResolvedRemoteCacheCredentials
}

/**
 * Every environment variable name a resolved credential reads.
 *
 * Callers withhold these from child processes, so both halves of a split have
 * to be listed. Missing one is how a target got to read the credential it was
 * never meant to hold.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const credentialEnvNames = (
  credentials: ResolvedRemoteCacheCredentials
): ReadonlyArray<string> =>
  credentials._tag === "shared"
    ? [credentials.tokenEnv]
    : [credentials.readTokenEnv, credentials.writeTokenEnv]

/**
 * A resolved remote cache with the readers that fetch its credentials.
 *
 * The readers are invoked only while an outbound request is being built, so a
 * credential is never held in a field anything can serialize. A shared
 * declaration returns the same value from both.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RemoteCacheAccess extends ResolvedRemoteCache {
  readonly readToken: () => string | undefined
  readonly writeToken: () => string | undefined
  /**
   * The trust domain this process publishes into, or undefined for the
   * trusted one. Host state: which domain a job runs in is a property of the
   * job, not of the workspace it builds.
   */
  readonly publishNamespace: string | undefined
}

/**
 * Resolves the optional remote cache for a workspace.
 *
 * `SMITHERS_CACHE_URL`, captured by the CLI before BUILD.ts evaluation, takes
 * precedence over the root BUILD.ts declaration. The declaration still selects
 * the bearer-token environment variables: one for both directions, or a read
 * name and a write name, defaulting to `SMITHERS_CACHE_TOKEN`. Token values
 * are never returned by this discovery function and never enter declaration or
 * target key material.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const resolveRemoteCache = async (
  root: string,
  endpointOverride?: string | undefined
): Promise<ResolvedRemoteCache | undefined> => {
  const canonical = await SafeFs.canonicalRoot(root)
  const entry = await buildEntry(canonical, "BUILD.ts")
  const declaration = entry === undefined ? undefined : declaredRemoteCache(await importNamespace(entry))
  const credentials = (): ResolvedRemoteCacheCredentials => {
    const read = declaration?.token.env ?? RemoteCache.defaultTokenEnv
    const write = declaration?.write?.env
    // The endpoint may be overridden per host; which credentials the workspace
    // declared may not, so the split survives an override.
    return write === undefined
      ? { _tag: "shared", tokenEnv: RemoteCache.normalizeTokenEnv(read) }
      : {
        _tag: "split",
        readTokenEnv: RemoteCache.normalizeTokenEnv(read),
        writeTokenEnv: RemoteCache.normalizeTokenEnv(write)
      }
  }
  const override = endpointOverride?.trim()
  if (override !== undefined && override !== "") {
    return { endpoint: RemoteCache.normalizeEndpoint(override), credentials: credentials() }
  }
  if (declaration === undefined) return undefined
  return { endpoint: RemoteCache.normalizeEndpoint(declaration.endpoint), credentials: credentials() }
}

const gitignoreForms = (cacheDirectory: string): ReadonlyArray<string> => [
  cacheDirectory,
  `${cacheDirectory}/`,
  `/${cacheDirectory}`,
  `/${cacheDirectory}/`
]

/**
 * Returns an open(2) flag the platform may not provide. Windows builds of
 * libuv define neither `O_NOFOLLOW` nor `O_NONBLOCK`; a missing flag
 * contributes nothing rather than crashing the open.
 */
const optionalOpenFlag = (name: "O_NOFOLLOW" | "O_NONBLOCK"): number =>
  (NodeFs.constants as Partial<Record<string, number>>)[name] ?? 0

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "code")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

const failureMessage = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) return "unavailable failure"
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" &&
        descriptor.value !== ""
      ? descriptor.value
      : "unavailable failure"
  } catch {
    return "unavailable failure"
  }
}

/**
 * Reads the root `.gitignore`, or returns undefined when there is none.
 *
 * Only `ENOENT` means absent. Every other failure is reported: treating a
 * permission error as "the file is not there" made the next step append the
 * entry to an empty prefix and replace a `.gitignore` this process could not
 * even read.
 *
 * The path is checked with `lstat` before it is opened and must be a regular
 * file. A symbolic link, a FIFO, a device, and a directory are all refused
 * rather than followed: a `.gitignore` symlink would otherwise decide what
 * this function reads, and — through the write that follows — what it
 * overwrites. The open then adds `O_NOFOLLOW` and `O_NONBLOCK` where the
 * platform provides them, and the descriptor is `fstat`-checked to be the same
 * regular file the `lstat` saw before a byte is read. The descriptor size is
 * bounded before allocation, one byte of slack detects growth, and a second
 * descriptor stat proves the same file remained stable through the read.
 * Invalid UTF-8 is refused rather than repaired with replacement characters.
 *
 * This deliberately does not use `SafeFs.readText`, which follows a link whose
 * whole resolution stays inside the workspace. That policy is right for a read:
 * an in-workspace link names in-workspace content. It is wrong here, because
 * what follows this read is a write, and publishing through a link would
 * replace a file at a path this function never decided to touch. A read that is
 * half of a read-modify-write gets the stricter target.
 */
const readGitignore = async (path: string): Promise<string | undefined> => {
  let expected: NodeFs.BigIntStats
  try {
    expected = await Fs.lstat(path, { bigint: true })
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  }
  if (expected.isSymbolicLink()) {
    throw new Error(`.gitignore is a symbolic link; refusing to read or replace it through the link: ${path}`)
  }
  if (!expected.isFile()) throw new Error(`.gitignore is not a regular file: ${path}`)
  if (expected.nlink !== 1n) throw new Error(`.gitignore must not be hard-linked: ${path}`)
  if (expected.size > BigInt(maximumGitignoreBytes)) {
    throw new Error(`.gitignore exceeds its ${maximumGitignoreBytes}-byte limit: ${path}`)
  }
  const handle = await Fs.open(
    path,
    NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
  )
  let primary: { readonly cause: unknown } | undefined
  let text: string | undefined
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.nlink !== 1n ||
      opened.size !== expected.size ||
      opened.mtimeNs !== expected.mtimeNs ||
      opened.ctimeNs !== expected.ctimeNs ||
      opened.size > BigInt(maximumGitignoreBytes)
    ) {
      throw new Error(`.gitignore changed identity while it was being read: ${path}`)
    }
    const buffer = Buffer.allocUnsafe(Number(opened.size) + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length)
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength - length) {
        throw new Error(`.gitignore returned an invalid read length: ${path}`)
      }
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== opened.nlink ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      BigInt(length) !== opened.size
    ) {
      throw new Error(`.gitignore changed while it was being read: ${path}`)
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      throw new Error(`.gitignore is not valid UTF-8: ${path}`)
    }
  } catch (cause) {
    primary = { cause }
  }
  try {
    await handle.close()
  } catch (cause) {
    primary ??= { cause }
  }
  if (primary !== undefined) throw primary.cause
  return text
}

/**
 * Ensures the root `.gitignore` ignores the resolved cache directory.
 *
 * The write is idempotent: any of the four equivalent entry spellings already
 * present leaves the file untouched, and a missing `.gitignore` is created
 * with the entry alone.
 *
 * Publication reuses {@link writeGeneratedFile}, the same atomic writer every
 * generated file goes through, so the whole file appears at once: contents go
 * to an exclusively created sibling temp that is written, fsynced, and closed
 * before the rename, the existing file's permission bits are preserved, a
 * failed close never publishes as success, and a temp is never leaked
 * silently. `Exec.resolveWorkspacePath` refuses a path that leaves the
 * workspace once symbolic links resolve.
 *
 * ## Boundary
 *
 * This is read-modify-write with no compare-and-swap: the filesystem offers no
 * portable way to publish a file only if it still holds the bytes that were
 * read. Two processes racing here both read the same file and both publish a
 * whole, valid file, and the last rename wins. Because every writer derives
 * the same contents from the same base, the loser's result is byte-identical
 * to the winner's; a reader can never observe a partial or interleaved file.
 * An unrelated edit that lands between this read and this write is the case
 * that would be lost, which is why the write only ever happens when the entry
 * is genuinely absent.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const ensureGitignored = async (
  root: string,
  cacheDirectory: string
): Promise<void> => {
  const normalized = Config.normalizeCacheDirectory(cacheDirectory)
  const absolute = NodePath.resolve(root)
  const text = await readGitignore(NodePath.join(absolute, ".gitignore"))
  const entry = `/${normalized.replace(/([*?[\]\\])/g, "\\$1")}/`
  const forms = [...gitignoreForms(normalized), entry]
  if (text !== undefined && text.split("\n").some((line) => forms.includes(line.trim()))) return
  const prefix = text === undefined || text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`
  const exit = await Effect.runPromiseExit(
    writeGeneratedFile(absolute, { path: ".gitignore", contents: `${prefix}${entry}\n` })
  )
  if (Exit.isFailure(exit)) {
    const failure = Cause.squash(exit.cause)
    throw new Error(`could not update .gitignore: ${failureMessage(failure)}`)
  }
}

/**
 * Identifies one declaration by the directory it resolves from and its
 * content, so two structurally equal declarations from the same package
 * deduplicate even when they are distinct objects.
 */
const declarationKey = (packagePath: string, declaration: Input.Declared): string =>
  `${packagePath}\0${JSON.stringify(declaration)}`

/**
 * Lists every file group reachable from a target's direct dependencies, depth
 * first and once each. Only groups contribute files; every other dependency
 * reaches the consumer's key through its own key alone.
 */
const groupClosure = (
  dependencies: ReadonlyArray<Target.AnyTarget>
): ReadonlyArray<Target.AnyTarget> => {
  const found: Array<Target.AnyTarget> = []
  const seen = new Set<Target.AnyTarget>()
  const visit = (targets: ReadonlyArray<Target.AnyTarget>): void => {
    for (const target of targets) {
      if (!isFilegroup(target) || seen.has(target)) continue
      seen.add(target)
      found.push(target)
      visit(Target.metadata(target).dependencies)
    }
  }
  visit(dependencies)
  return found
}

const packagePathForBuild = (buildFile: string): string => {
  const directory = posix(NodePath.dirname(buildFile))
  return directory === "." ? "" : directory
}

/**
 * A workspace index that imports only BUILD.ts modules selected by a label or
 * reached through a direct target dependency, and synthesizes default-target
 * targets for marker directories without a BUILD.ts file.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Workspace {
  readonly root: string
  readonly currentPackage: string
  readonly cacheDirectory: string
  readonly files: ReadonlyArray<string>
  readonly buildFiles: ReadonlyArray<string>
  readonly defaultRules: Array<PackageDefaultsEntry> = []
  private readonly modules = new Map<string, Promise<BuildModule>>()
  private readonly labels = new Map<string, Target.AnyTarget>()
  private readonly targetLabels = new Map<Target.AnyTarget, string>()
  private readonly synthesized = new Map<string, ReadonlyMap<string, Target.AnyTarget>>()
  private readonly inputPackages = new WeakMap<ExpandedInput, string>()
  /** BUILD.ts files whose import has started and not finished. */
  private readonly importing = new Set<string>()
  /** Cancels discovery, input expansion, planning, and execution as one operation. */
  readonly signal: AbortSignal | undefined

  private constructor(
    root: string,
    cwd: string,
    cacheDirectory: string,
    files: ReadonlyArray<string>,
    signal?: AbortSignal | undefined
  ) {
    this.root = root
    this.currentPackage = Label.currentPackage(root, cwd)
    this.cacheDirectory = cacheDirectory
    this.files = files
    this.signal = signal
    this.buildFiles = files.filter((file) => file === "BUILD.ts" || file.endsWith("/BUILD.ts"))
  }

  /**
   * Discovers non-ignored workspace paths without evaluating a BUILD.ts file.
   *
   * `options.cacheDirectory` is the directory {@link resolveConfig} settled on
   * and defaults to `.flows`. Discovery never lists a path inside it, and each
   * declared-input expansion receives the same value explicitly.
   *
   * @category constructors
   * @since 0.1.0
   */
  static async make(
    root: string,
    cwd: string,
    options: {
      readonly cacheDirectory?: string | undefined
      readonly signal?: AbortSignal | undefined
    } = {}
  ): Promise<Workspace> {
    // Module loaders report source filenames through the host's canonical
    // path (macOS expands /var to /private/var). Canonicalize the workspace
    // once so a BUILD.ts dependency is not misclassified as outside merely
    // because its stack uses the resolved spelling.
    const absolute = await Fs.realpath(NodePath.resolve(root))
    const stats = await Fs.stat(absolute)
    if (!stats.isDirectory()) throw new Error(`workspace is not a directory: ${absolute}`)
    const cacheDirectory = options.cacheDirectory === undefined
      ? Config.defaultCacheDirectory
      : Config.normalizeCacheDirectory(options.cacheDirectory)
    const resolvedCwd = NodePath.resolve(cwd)
    const relativeCwd = NodePath.relative(absolute, resolvedCwd)
    const effectiveCwd = relativeCwd.startsWith("..") || NodePath.isAbsolute(relativeCwd)
      ? absolute
      : resolvedCwd
    return new Workspace(
      absolute,
      effectiveCwd,
      cacheDirectory,
      await workspaceFiles(absolute, cacheDirectory, options.signal),
      options.signal
    )
  }

  private relativeBuild(source: string): string {
    const relative = posix(NodePath.relative(this.root, NodePath.resolve(source)))
    if (relative.startsWith("../") || NodePath.isAbsolute(relative)) {
      throw new Error(`target source is outside workspace: ${source}`)
    }
    return relative
  }

  private buildForPackage(packagePath: string): string {
    return packagePath === "" ? "BUILD.ts" : `${packagePath}/BUILD.ts`
  }

  /**
   * Imports and indexes one BUILD.ts module through tsx's programmatic loader.
   *
   * @category loading
   * @since 0.1.0
   */
  loadBuild(file: string): Promise<BuildModule> {
    const relative = this.relativeBuild(NodePath.isAbsolute(file) ? file : NodePath.join(this.root, file))
    if (!this.buildFiles.includes(relative)) throw new Error(`BUILD.ts is not discoverable: ${relative}`)
    const existing = this.modules.get(relative)
    if (existing !== undefined) return existing
    const loaded = this.importBuild(relative)
    this.modules.set(relative, loaded)
    return loaded
  }

  /**
   * Registers one target under its path-derived label.
   *
   * One target value may only ever answer to one label. Two names for one value
   * would give the graph two nodes that execute the same Flow, and a dependent
   * blocked on one of them would be released by the other.
   */
  private register(
    targets: Map<string, Target.AnyTarget>,
    packagePath: string,
    name: string,
    target: Target.AnyTarget
  ): void {
    const label = Label.format(packagePath, name)
    const previous = this.targetLabels.get(target)
    if (previous !== undefined && previous !== label) {
      throw new Error(`one target value is exported under both ${previous} and ${label}`)
    }
    targets.set(name, target)
    this.labels.set(label, target)
    this.targetLabels.set(target, label)
  }

  /**
   * Expands one package manifest declaration into its check, write, and refresh
   * targets, and registers them under the declaration's own export name plus a
   * suffix. A declaration exported as `packageJson` becomes `packageJsonCheck`,
   * `packageJsonWrite`, and `packageJsonRefresh`.
   *
   * `resolve` answers with the label of a target the declaration names, and
   * throws when the target is not in the graph. That refusal is the whole point
   * of resolving here: a script that names an unreachable target is a manifest
   * entry no user could run, and it fails while the workspace is being analysed
   * rather than after the package is published.
   */
  private expandDeclaration(
    targets: Map<string, Target.AnyTarget>,
    packagePath: string,
    name: string,
    declaration: PackageJson.Declaration,
    resolve: (target: Target.AnyTarget) => string
  ): void {
    const expanded = PackageJson.targets(declaration, packagePath, resolve)
    for (const [key, suffix] of PackageJson.targetSuffixes) {
      this.register(targets, packagePath, `${name}${suffix}`, expanded[key])
    }
  }

  /** Every target a manifest declaration names and therefore needs a label for. */
  private declarationTargets(declaration: PackageJson.Declaration): ReadonlyArray<Target.AnyTarget> {
    const named = Object.values(declaration.scripts)
    return declaration.publish === undefined ? named : [...named, declaration.publish.entry]
  }

  private async importBuild(relative: string): Promise<BuildModule> {
    const entry = await buildEntry(this.root, relative)
    if (entry === undefined) throw new Error(`BUILD.ts no longer exists: ${relative}`)
    const namespace: unknown = await importNamespace(entry)
    if (typeof namespace !== "object" || namespace === null) {
      throw new Error(`BUILD.ts did not evaluate to a module namespace: ${relative}`)
    }
    const packagePath = packagePathForBuild(relative)
    const targets = new Map<string, Target.AnyTarget>()
    const defaults: Array<PackageDefaults.PackageDefaults> = []
    const declarations: Array<readonly [string, PackageJson.Declaration]> = []
    for (const [name, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
      if (Target.isTarget(value)) {
        this.register(targets, packagePath, name, value)
      } else if (PackageDefaults.isPackageDefaults(value)) {
        defaults.push(value)
        if (!this.defaultRules.some((entry) => entry.declaration === value)) {
          this.defaultRules.push({ declaration: value, packagePath })
        }
      } else if (PackageJson.isDeclaration(value)) {
        declarations.push([name, value])
      }
    }
    // Manifest declarations expand in a second pass, after every target this
    // module exports is registered: a package's own `scripts` normally name its
    // own targets, and a first pass would resolve them by import order instead
    // of by what the module exports.
    const resolved = new Map<Target.AnyTarget, string>()
    this.importing.add(relative)
    try {
      for (const [, declaration] of declarations) {
        for (const target of this.declarationTargets(declaration)) {
          if (resolved.has(target)) continue
          const known = this.targetLabels.get(target)
          if (known !== undefined) {
            resolved.set(target, known)
            continue
          }
          // Resolving a foreign target loads the BUILD.ts that exports it.
          // A file already being imported cannot answer, and awaiting its
          // in-flight promise from inside itself would hang the command
          // instead of reporting anything.
          const source = Target.metadata(target).sourceFile
          const owner = source === undefined ? undefined : this.relativeBuild(source)
          if (owner !== undefined && this.importing.has(owner)) {
            throw new Error(
              `a package manifest in ${relative} names a target from ${owner}, whose manifest names one back; ` +
                `break the cycle by declaring the script command in the template instead`
            )
          }
          resolved.set(target, await this.label(target))
        }
      }
    } finally {
      this.importing.delete(relative)
    }
    const resolve = (target: Target.AnyTarget): string => {
      const label = resolved.get(target)
      if (label === undefined) {
        throw new Error(
          `a package manifest in ${relative} names a target with no label; export it from a BUILD.ts file`
        )
      }
      return label
    }
    for (const [name, declaration] of declarations) {
      this.expandDeclaration(targets, packagePath, name, declaration, resolve)
    }
    return { file: relative, targets, defaults }
  }

  private defaultTarget(packagePath: string, targets: ReadonlyMap<string, Target.AnyTarget>): Target.AnyTarget {
    const basename = packagePath === "" ? "" : packagePath.split("/").at(-1) ?? ""
    const candidates = ["lib", "nodeModules", basename, "default"]
    for (const candidate of candidates) {
      const target = targets.get(candidate)
      if (target !== undefined) return target
    }
    if (targets.size === 1) return [...targets.values()][0]!
    throw new Error(`package //${packagePath} has no unambiguous default target`)
  }

  /**
   * Loads the root BUILD.ts file so workspace-level default-target declarations
   * are discovered before any synthesis decision.
   */
  private async ensureDefaults(): Promise<void> {
    if (this.buildFiles.includes("BUILD.ts")) await this.loadBuild("BUILD.ts")
  }

  private hasFile(path: string): boolean {
    return this.files.includes(path)
  }

  private eligible(entry: PackageDefaultsEntry, directory: string): boolean {
    const prefix = directory === "" ? "" : `${directory}/`
    return this.hasFile(`${prefix}${entry.declaration.marker}`) &&
      !this.hasFile(`${prefix}${entry.declaration.unless}`) &&
      PackageDefaults.matches(entry.declaration, entry.packagePath, directory)
  }

  /**
   * Applies the first eligible default-target declaration to one directory and
   * registers the synthesized targets under path-derived labels. Returns
   * undefined when no declaration matches.
   *
   * @category synthesis
   * @since 0.1.0
   */
  synthesizeDirectory(directory: string): ReadonlyMap<string, Target.AnyTarget> | undefined {
    const existing = this.synthesized.get(directory)
    if (existing !== undefined) return existing
    const entry = this.defaultRules.find((candidate) => this.eligible(candidate, directory))
    if (entry === undefined) return undefined
    const expansion = PackageDefaults.expand(entry.declaration, directory)
    const targets = new Map<string, Target.AnyTarget>()
    for (const [name, target] of expansion.targets) this.register(targets, directory, name, target)
    // A synthesized manifest may only name targets from the same macro
    // application. There is no BUILD.ts here to import another package's
    // targets from, so the record the macro just returned is the whole graph a
    // declaration can reach, and a name outside it fails now.
    const resolve = (target: Target.AnyTarget): string => {
      const label = this.targetLabels.get(target)
      if (label === undefined || !targets.has(label.slice(label.indexOf(":") + 1))) {
        throw new Error(
          `the default target for //${directory} declares a manifest naming a target it did not synthesize`
        )
      }
      return label
    }
    for (const [name, declaration] of expansion.declarations) {
      this.expandDeclaration(targets, directory, name, declaration, resolve)
    }
    this.synthesized.set(directory, targets)
    return targets
  }

  /**
   * Lists every directory eligible for default-target synthesis, in sorted
   * order: it matches a declaration's glob, contains the marker file, and has
   * no BUILD.ts (or other `unless`) file.
   *
   * @category synthesis
   * @since 0.1.0
   */
  synthesizedDirectories(): ReadonlyArray<string> {
    const directories = new Set<string>()
    for (const entry of this.defaultRules) {
      const suffix = `/${entry.declaration.marker}`
      for (const file of this.files) {
        const directory = file === entry.declaration.marker
          ? ""
          : file.endsWith(suffix)
          ? file.slice(0, -suffix.length)
          : undefined
        if (directory !== undefined && this.eligible(entry, directory)) directories.add(directory)
      }
    }
    return [...directories].sort()
  }

  /**
   * Resolves a label pattern while evaluating only selected BUILD.ts modules.
   *
   * Packages without a BUILD.ts file resolve through default-target synthesis
   * when a workspace declaration matches their directory.
   *
   * @category querying
   * @since 0.1.0
   */
  async targets(patternText: string): Promise<ReadonlyArray<Target.AnyTarget>> {
    const pattern = Label.parse(patternText, this.currentPackage)
    if (pattern._tag === "Exact") {
      const targets = await this.packageTargets(pattern.packagePath)
      return [this.select(pattern.packagePath, targets, pattern.target)]
    }
    const prefix = pattern.packagePath === "" ? "" : `${pattern.packagePath}/`
    const selected = this.buildFiles.filter((file) => file.startsWith(prefix))
    const modules = await Promise.all(selected.map((file) => this.loadBuild(file)))
    await this.ensureDefaults()
    const synthesized: Array<Target.AnyTarget> = []
    for (const directory of this.synthesizedDirectories()) {
      if (directory !== pattern.packagePath && !directory.startsWith(prefix)) continue
      const targets = this.synthesizeDirectory(directory)
      if (targets !== undefined) synthesized.push(...targets.values())
    }
    return [...modules.flatMap((module) => [...module.targets.values()]), ...synthesized]
  }

  /**
   * Resolves the complete target map of one package, loading its BUILD.ts or
   * synthesizing it through the first eligible default-target declaration.
   *
   * @category querying
   * @since 0.1.0
   */
  async packageTargets(packagePath: string): Promise<ReadonlyMap<string, Target.AnyTarget>> {
    const buildFile = this.buildForPackage(packagePath)
    if (this.buildFiles.includes(buildFile)) {
      return (await this.loadBuild(buildFile)).targets
    }
    await this.ensureDefaults()
    const targets = this.synthesizeDirectory(packagePath)
    if (targets === undefined) {
      throw new Error(`package //${packagePath} has no BUILD.ts and matches no default target`)
    }
    return targets
  }

  private select(
    packagePath: string,
    targets: ReadonlyMap<string, Target.AnyTarget>,
    name: string | undefined
  ): Target.AnyTarget {
    if (name === undefined) return this.defaultTarget(packagePath, targets)
    const target = targets.get(name)
    if (target === undefined) throw new Error(`target not found: ${Label.format(packagePath, name)}`)
    return target
  }

  /**
   * Resolves the path-derived label of an exported target dependency.
   *
   * @category querying
   * @since 0.1.0
   */
  async label(target: Target.AnyTarget): Promise<string> {
    const known = this.targetLabels.get(target)
    if (known !== undefined) return known
    const source = Target.metadata(target).sourceFile
    if (source !== undefined) {
      const relative = this.relativeBuild(source)
      const loaded = await this.loadBuild(relative)
      const resolved = this.targetLabels.get(target)
      if (resolved !== undefined) return resolved
      // `tsx`'s programmatic import scopes each top-level call to its own
      // namespace. A BUILD.ts reached first through another BUILD's relative
      // import can therefore be the same declaration in a distinct module
      // instance when the index later loads its source directly. Reconcile
      // that duplicate by its source-local declaration identity: the target
      // name and the canonicalized attrs from the same source file.
      //
      // `implementationDigest` is deliberately NOT part of this match. The
      // digest hashes the transpiled text of the target's option functions, and
      // two module instances of one targets package can be transpiled by
      // different tsx pipelines (the CommonJS require bridge versus the ESM
      // loader), which annotate the emitted functions differently on some
      // Node versions. The digest is per-instance context; the declaration
      // identity a label needs is target plus attrs in one file, and two
      // structurally identical declarations in one file are genuinely
      // ambiguous with or without the digest.
      const metadata = Target.metadata(target)
      const matches = [...loaded.targets].filter(([, candidate]) => {
        const candidateMetadata = Target.metadata(candidate)
        return candidateMetadata.target === metadata.target &&
          JSON.stringify(candidateMetadata.attrs) === JSON.stringify(metadata.attrs)
      })
      if (matches.length === 1) {
        const label = Label.format(packagePathForBuild(relative), matches[0]![0])
        this.targetLabels.set(target, label)
        return label
      }
    }
    throw new Error(`could not derive a label for ${Target.metadata(target).target}; export it from a BUILD.ts file`)
  }

  private packagePathOf(target: Target.AnyTarget): string {
    const label = this.targetLabels.get(target)
    if (label !== undefined) return Label.parse(label, this.currentPackage).packagePath
    const source = Target.metadata(target).sourceFile
    return source === undefined ? "" : packagePathForBuild(this.relativeBuild(source))
  }

  /** Resolves the package directory declarations on one target use. */
  private inputPackagePathOf(target: Target.AnyTarget): string {
    const packagePath = this.packagePathOf(target)
    if (!isFilegroup(target)) return packagePath
    const attrs = Target.metadata(target).attrs
    if (
      typeof attrs !== "object" ||
      attrs === null ||
      !("cwd" in attrs) ||
      typeof attrs.cwd !== "string" ||
      attrs.cwd === "."
    ) return packagePath
    const resolved = Input.resolvePath("", attrs.cwd)
    return resolved === "." ? "" : resolved
  }

  /**
   * Expands and digests one target's declared inputs, then projects the
   * transitive contents of every file group the target names.
   *
   * Globs expand through {@link Input.expandGlob} and files digest through
   * {@link Input.digestFile}, so the same content always produces the same
   * digest regardless of discovery order. `declarations` overrides the
   * metadata input list for callers holding a verb-effective view from
   * `Target.Metadata.forKind`.
   *
   * A `Filegroup` in a target's attrs is a dependency edge, and a dependency
   * key alone would only re-key the consumer through the group's key. The
   * projection makes the relationship direct: every group reachable from the
   * target contributes its own declarations, expanded against the group's
   * package directory, to the consumer's declared inputs. Editing any member
   * of any group therefore invalidates every consumer of that group. Group
   * declarations that repeat one the target already declares, or that a
   * shallower group already contributed, are added once, and the traversal is
   * depth first in `srcs` order, so the projection is deterministic.
   *
   * @category discovery
   * @since 0.1.0
   */
  async expandInputs(
    target: Target.AnyTarget,
    declarations?: ReadonlyArray<Input.Declared>,
    dependencies?: ReadonlyArray<Target.AnyTarget>
  ): Promise<ReadonlyArray<ExpandedInput>> {
    const metadata = Target.metadata(target)
    const packagePath = this.inputPackagePathOf(target)
    const own = declarations ?? metadata.inputs
    const expanded = [...await this.expandDeclarations(packagePath, own)]
    const seen = new Set(own.map((declaration) => declarationKey(packagePath, declaration)))
    for (const group of groupClosure(dependencies ?? metadata.dependencies)) {
      const groupPath = this.inputPackagePathOf(group)
      const fresh = Target.metadata(group).inputs.filter((declaration) => {
        const key = declarationKey(groupPath, declaration)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      expanded.push(...await this.expandDeclarations(groupPath, fresh))
    }
    return expanded
  }

  /**
   * Re-expands planned inputs against the package each declaration came from.
   *
   * Filegroup projection can add declarations from packages other than the
   * consumer's. Keeping that origin out of the public plan shape preserves
   * the existing output contract, while this workspace-local association
   * lets cache admission measure the same declarations from the same package
   * after execution.
   *
   * @category discovery
   * @since 0.1.0
   */
  async reexpandInputs(
    inputs: ReadonlyArray<ExpandedInput>
  ): Promise<ReadonlyArray<ExpandedInput>> {
    const expanded: Array<ExpandedInput> = []
    for (const input of inputs) {
      const packagePath = this.inputPackages.get(input)
      if (packagePath === undefined) {
        throw new Error("expanded input did not originate from this workspace")
      }
      expanded.push(...await this.expandDeclarations(packagePath, [input.declaration]))
    }
    return expanded
  }

  /**
   * Expands and digests one declaration list against one package directory.
   */
  private async expandDeclarations(
    packagePath: string,
    declarations: ReadonlyArray<Input.Declared>
  ): Promise<ReadonlyArray<ExpandedInput>> {
    const expanded: Array<ExpandedInput> = []
    for (const declaration of declarations) {
      if (declaration._tag === "File") {
        const path = Input.resolvePath(packagePath, declaration.path)
        if (inWorkspaceStateDirectory(this.cacheDirectory, path)) {
          const files: ReadonlyArray<FileDigest> = []
          const input = { declaration, files, digest: Input.digestText(JSON.stringify(files)) }
          this.inputPackages.set(input, packagePath)
          expanded.push(input)
          continue
        }
        const digest = await Input.digestFile(NodePath.join(this.root, path), {
          workspaceRoot: this.root,
          signal: this.signal
        })
        const files = [{ path, digest }]
        const input = { declaration, files, digest: Input.digestText(JSON.stringify(files)) }
        this.inputPackages.set(input, packagePath)
        expanded.push(input)
        continue
      }
      if (declaration._tag === "Glob") {
        const matches = await Input.expandGlob(this.root, packagePath, declaration, {
          cacheDirectory: this.cacheDirectory,
          signal: this.signal
        })
        const files = await Input.digestFiles(this.root, matches, { signal: this.signal })
        const input = { declaration, files, digest: Input.digestText(JSON.stringify(files)) }
        this.inputPackages.set(input, packagePath)
        expanded.push(input)
        continue
      }
      if (declaration._tag === "PnpmWorkspace") {
        const matches = await Input.expandPnpmWorkspace(this.root, packagePath, declaration, {
          cacheDirectory: this.cacheDirectory,
          signal: this.signal
        })
        const files = await Input.digestFiles(this.root, matches, { signal: this.signal })
        const input = { declaration, files, digest: Input.digestText(JSON.stringify(files)) }
        this.inputPackages.set(input, packagePath)
        expanded.push(input)
        continue
      }
      const base = Input.validateGitBase(declaration.base)
      const names = await runGit(
        this.root,
        ["diff", "--name-only", "-z", "--end-of-options", base, "--"],
        this.signal
      )
      // A diff listing reaches a digest and a patch argument, so it is
      // validated exactly as `ls-files` output is. git never quotes `-z`
      // output, so an absolute or traversing entry is not a path git found in
      // this workspace.
      const paths = gitPaths(nulPaths(names), this.cacheDirectory)
      const files = await Input.digestFiles(this.root, paths, { signal: this.signal })
      const patch = files.length === 0
        ? ""
        : await runGit(
          this.root,
          ["diff", "--binary", "--end-of-options", base, "--", ...paths],
          this.signal
        )
      const input = {
        declaration,
        files,
        digest: Input.digestText(JSON.stringify({ patch, files }))
      }
      this.inputPackages.set(input, packagePath)
      expanded.push(input)
    }
    return expanded
  }
}
