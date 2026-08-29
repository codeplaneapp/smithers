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

/**
 * How an enumeration talks to a FileSystem that does not speak
 * workspace-relative paths.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface EnumerationOptions {
  /**
   * Maps a workspace-relative path (`""` names the workspace root) to the
   * coordinate the FileSystem expects. Defaults to the identity, with `""`
   * spelled `"."`.
   */
  readonly resolve?: (path: string) => string
}

/** @internal */
const defaultResolve = (path: string): string => path === "" ? "." : path

/**
 * Every file under `dir` (workspace-relative; `""` for the workspace root),
 * as sorted workspace-relative paths. A missing directory enumerates to
 * nothing — a zero-match expansion is legal, so absence is a fact rather than
 * a failure.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
 */
export const filesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    // The workspace root itself always exists; a host may not even answer
    // `exists` for its own spelling of it, so only subtrees are probed.
    const present = dir === "" || (yield* fs.exists(resolve(dir)))
    if (!present) return []
    const entries = yield* fs.readDirectory(resolve(dir), { recursive: true })
    const files: Array<string> = []
    for (const entry of entries) {
      const relative = entry.replaceAll("\\", "/")
      const path = dir === "" ? relative : `${dir}/${relative}`
      const info = yield* fs.stat(resolve(path))
      if (info.type === "File") files.push(path)
    }
    return files.sort()
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
 * @slop
 */
export const entriesUnder = (
  fs: FileSystem.FileSystem,
  dir: string,
  options: EnumerationOptions = {}
): Effect.Effect<
  { readonly files: ReadonlyArray<string>; readonly directories: ReadonlyArray<string> },
  PlatformError.PlatformError
> =>
  Effect.gen(function*() {
    const resolve = options.resolve ?? defaultResolve
    const present = yield* fs.exists(resolve(dir))
    if (!present) return { files: [], directories: [] }
    const entries = yield* fs.readDirectory(resolve(dir), { recursive: true })
    const files: Array<string> = []
    const directories: Array<string> = [dir]
    for (const entry of entries) {
      const relative = entry.replaceAll("\\", "/")
      const path = `${dir}/${relative}`
      const info = yield* fs.stat(resolve(path))
      if (info.type === "File") files.push(path)
      else {
        /* v8 ignore else -- special entries (symlinks, sockets) are neither materializable leaves nor prunable scaffolding */
        if (info.type === "Directory") directories.push(path)
      }
    }
    return { files: files.sort(), directories: directories.sort() }
  })

/**
 * The longest directory prefix of a pattern that contains no wildcard — the
 * subtree a walk has to visit. `src/**` walks `src`; `*.txt` walks the root.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
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
 * @slop
 */
export const expandGlob = (
  fs: FileSystem.FileSystem,
  glob: FileSet.Glob,
  options: EnumerationOptions = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const matched = new Set<string>()
    const walked = new Set<string>()
    for (const include of glob.include) {
      const prefix = staticPrefix(include)
      if (walked.has(prefix)) continue
      walked.add(prefix)
      for (const path of yield* filesUnder(fs, prefix, options)) {
        if (FileSet.matchesGlob(glob, path)) matched.add(path)
      }
    }
    return [...matched].sort()
  })
