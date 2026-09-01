/**
 * Workspace-relative file enumeration for glob and tree-artifact expansion.
 *
 * The host `glob` is deliberately not consulted. Two divergences make it the
 * wrong oracle for a declared pattern: the kernel `FileSystem` absolutizes
 * patterns against the workspace root and returns absolute paths, so a
 * workspace-relative matcher filters every result out; and Node's matcher
 * skips dotfiles, which `FileSet.matchesPattern` — and Bazel's glob — cover.
 * Walking `readDirectory` and filtering through `FileSet` keeps every
 * expansion byte-identical to the matcher the plan's overlap passes use, in
 * the one coordinate system declarations are written in.
 *
 * @since 0.1.0
 */
import * as FileSet from "@smthrs/plan/FileSet"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"

/**
 * The default maximum number of directory entries visited by one expansion.
 *
 * @since 1.0.0
 * @category constants
 */
export const defaultMaxEntries = 100_000

/**
 * The stable error code returned when enumeration exceeds its safety bound.
 *
 * @since 1.0.0
 * @category errors
 */
export const FileEnumerationErrorCode = Schema.Literal("entry_limit_exceeded")

/**
 * The stable error code returned when enumeration exceeds its safety bound.
 *
 * @since 1.0.0
 * @category errors
 */
export type FileEnumerationErrorCode = typeof FileEnumerationErrorCode.Type

/**
 * A workspace enumeration exceeded its configured entry limit.
 *
 * @since 1.0.0
 * @category errors
 */
export class FileEnumerationError extends Schema.TaggedError<FileEnumerationError>()(
  "@smthrs/engine-store/FileEnumerationError",
  {
    code: FileEnumerationErrorCode,
    message: Schema.String,
    pattern: Schema.String,
    limit: Schema.Number,
    cause: Schema.Unknown
  }
) {}

/**
 * How an enumeration talks to a FileSystem that does not speak
 * workspace-relative paths.
 *
 * @since 0.1.0
 * @category models
 */
export interface EnumerationOptions {
  /**
   * Maps a workspace-relative path (`""` names the workspace root) to the
   * coordinate the FileSystem expects. Defaults to the identity, with `""`
   * spelled `"."`.
   */
  readonly resolve?: (path: string) => string
  /**
   * Maximum number of directory entries one expansion may visit. Defaults to
   * {@link defaultMaxEntries}. Enumeration fails instead of returning a
   * partial result when the walk exceeds this bound.
   */
  readonly maxEntries?: number | undefined
}

/** @internal */
const defaultResolve = (path: string): string => path === "" ? "." : path

const ignoredDirectoryNames = new Set([".git", ".jj", "node_modules"])

interface EnumerationBudget {
  readonly limit: number
  count: number
  pattern: string
}

const budgetFor = (pattern: string, options: EnumerationOptions): EnumerationBudget => ({
  limit: options.maxEntries ?? defaultMaxEntries,
  count: 0,
  pattern
})

const explicitIgnoredDirectories = (dir: string): ReadonlySet<string> =>
  new Set(dir.replaceAll("\\", "/").split("/").filter((part) => ignoredDirectoryNames.has(part)))

const visit = (budget: EnumerationBudget): Effect.Effect<void, FileEnumerationError> => {
  budget.count += 1
  if (budget.count <= budget.limit) return Effect.void
  const message = `enumerating pattern ${JSON.stringify(budget.pattern)} exceeded the ${budget.limit}-entry limit`
  return Effect.fail(
    new FileEnumerationError({
      code: "entry_limit_exceeded",
      pattern: budget.pattern,
      limit: budget.limit,
      message,
      cause: new RangeError(message)
    })
  )
}

interface EnumeratedEntries {
  readonly files: ReadonlyArray<string>
  readonly directories: ReadonlyArray<string>
}

const enumerateUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  resolve: (path: string) => string,
  budget: EnumerationBudget
): Effect.Effect<EnumeratedEntries, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    // The workspace root itself always exists; a host may not even answer
    // `exists` for its own spelling of it, so only subtrees are probed.
    const present = dir === "" || (yield* fs.exists(resolve(dir)))
    if (!present) return { files: [], directories: [] }

    const files: Array<string> = []
    const directories: Array<string> = [dir]
    const pending: Array<string> = [dir]
    const explicit = explicitIgnoredDirectories(dir)
    while (pending.length > 0) {
      const current = pending.pop()!
      const entries = [...yield* fs.readDirectory(resolve(current))].sort()
      for (const entry of entries) {
        yield* visit(budget)
        const relative = entry.replaceAll("\\", "/")
        const path = current === "" ? relative : `${current}/${relative}`
        // Effect 4.0.0-rc.108 readDirectory returns names without entry types,
        // so this implementation must stat each visited entry.
        const info = yield* fs.stat(resolve(path))
        if (info.type === "File") {
          files.push(path)
          continue
        }
        if (info.type !== "Directory") continue
        const name = path.slice(path.lastIndexOf("/") + 1)
        if (ignoredDirectoryNames.has(name) && !explicit.has(name)) continue
        directories.push(path)
        pending.push(path)
      }
    }
    return { files: files.sort(), directories: directories.sort() }
  })

/**
 * Every file under `dir` (workspace-relative; `""` for the workspace root),
 * as sorted workspace-relative paths. A missing directory enumerates to
 * nothing — a zero-match expansion is legal, so absence is a fact rather than
 * a failure.
 *
 * @since 0.1.0
 * @category accessors
 */
export const filesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    return (yield* enumerateUnder(fs, dir, resolve, budgetFor(dir === "" ? "**" : `${dir}/**`, options))).files
  })

/**
 * Every file and every directory under `dir` (workspace-relative, non-empty),
 * as sorted workspace-relative paths. The directory list includes `dir`
 * itself, so a tree replay can audit exactly the scaffolding it may have to
 * prune. A missing directory enumerates to nothing — a tree that matched
 * nothing is legal, so absence is a fact rather than a failure.
 *
 * @since 0.1.0
 * @category accessors
 */
export const entriesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<
  { readonly files: ReadonlyArray<string>; readonly directories: ReadonlyArray<string> },
  PlatformError.PlatformError | FileEnumerationError
> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    return yield* enumerateUnder(fs, dir, resolve, budgetFor(`${dir}/**`, options))
  })

/**
 * The longest directory prefix of a pattern that contains no wildcard — the
 * subtree a walk has to visit. `src/**` walks `src`; `*.txt` walks the root.
 *
 * @since 0.1.0
 * @category accessors
 */
export const staticPrefix = (pattern: string): string => {
  const segments = pattern.replaceAll("\\", "/").split("/")
  const fixed: Array<string> = []
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes("*")) break
    fixed.push(segment)
  }
  return fixed.join("/")
}

/**
 * Expands one glob against the workspace: walk each include's static prefix,
 * keep the files `FileSet.matchesGlob` covers. Sorted and deduplicated, so
 * expansion is deterministic.
 *
 * @since 0.1.0
 * @category accessors
 */
export const expandGlob = (
  fs: FileSystem.FileSystem,
  glob: FileSet.Glob,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | FileEnumerationError> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    const matched = new Set<string>()
    const walked = new Set<string>()
    const budget = budgetFor("", options)
    for (const include of glob.include) {
      const prefix = staticPrefix(include)
      if (walked.has(prefix)) continue
      walked.add(prefix)
      budget.pattern = include
      for (const path of (yield* enumerateUnder(fs, prefix, resolve, budget)).files) {
        if (FileSet.matchesGlob(glob, path)) matched.add(path)
      }
    }
    return [...matched].sort()
  })
