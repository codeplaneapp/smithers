/**
 * Filesystem helpers shared by the scanners: a bounded directory walk with the
 * project ignore rules, and read helpers that turn a missing or unreadable file
 * into a typed `io` failure rather than a defect.
 *
 * @since 0.1.0
 * @private
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { io, type MigrateError } from "../MigrateError.ts"

/**
 * Directory names the scanner never descends into.
 *
 * `.smithers/executions`, `.smithers/runs`, and `.smithers/logs` hold run
 * state, which the tool reports on but never reads as source. `.flows` is the
 * new runtime's state directory and is not part of a 0.x project.
 *
 * @since 0.1.0
 * @private
 */
export const ignoredDirectories: ReadonlyArray<string> = [
  ".flows",
  ".git",
  ".jj",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]

/**
 * Paths, relative to the project root, that the walk skips wholesale.
 *
 * The keys are written from the project root. When the root *is* the pack
 * directory, the walk matches them again with the `.smithers/` prefix restored,
 * so pointing the tool at `<project>/.smithers` skips the same run state as
 * pointing it at `<project>`. Without that, a real pack costs the walk every
 * execution log and every worktree checkout under it: Plue's pack holds 2,465
 * execution files and 81,864 worktree files beside 500 source files.
 *
 * @since 0.1.0
 * @private
 */
export const ignoredPaths: ReadonlyArray<string> = [
  ".smithers-migrate",
  ".smithers/executions",
  ".smithers/logs",
  ".smithers/node_modules",
  ".smithers/runs",
  ".smithers/sandboxes",
  ".smithers/state",
  ".smithers/workflows/.worktrees"
]

/**
 * The walk's bounds. A 0.x project is application source, so an unbounded walk
 * over a monorepo checkout would spend minutes in directories the tool never
 * reads.
 *
 * @since 0.1.0
 * @private
 */
export const maxDepth = 12

/**
 * Options for {@link walk}.
 *
 * @since 0.1.0
 * @private
 */
export interface WalkOptions {
  readonly ignore?: ReadonlyArray<string> | undefined
  readonly maxDepth?: number | undefined
}

const relative = (root: string, path: Path.Path, absolute: string): string => {
  const value = path.relative(root, absolute)
  return value.split(path.sep).join("/")
}

/**
 * Lists every file under `root`, as paths relative to `root` with `/`
 * separators, sorted. Unreadable directories are skipped rather than failing
 * the walk: a project the operator cannot fully read is still worth reporting
 * on, and `Detect` records the skip as a warning.
 *
 * @since 0.1.0
 * @private
 */
export const walk = (
  root: string,
  options: WalkOptions = {}
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const skipped = new Set([...ignoredPaths, ...(options.ignore ?? [])])
    const limit = options.maxDepth ?? maxDepth
    const found: Array<string> = []
    // A root whose own name is `.smithers` is a pack directory, so the keys
    // above still apply once their prefix is put back.
    const packPrefix = path.basename(root) === ".smithers" ? ".smithers/" : undefined
    const isSkipped = (key: string): boolean =>
      skipped.has(key) || (packPrefix !== undefined && skipped.has(`${packPrefix}${key}`))

    const visit = (directory: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (depth > limit) return
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as Array<string>))
        for (const name of names.slice().sort()) {
          if (ignoredDirectories.includes(name)) continue
          const absolute = path.join(directory, name)
          const key = relative(root, path, absolute)
          if (isSkipped(key)) continue
          const info = yield* fs.stat(absolute).pipe(Effect.option)
          if (info._tag === "None") continue
          if (info.value.type === "Directory") {
            yield* visit(absolute, depth + 1)
          } else if (info.value.type === "File") {
            found.push(key)
          }
        }
      })

    yield* visit(root, 0)
    return found.sort()
  })

/**
 * Lists every file under `root` with no ignore rules at all, as paths relative
 * to `root` with `/` separators, sorted. Returns nothing when `root` is not a
 * directory.
 *
 * {@link walk} exists to skip what a scanner must not read. This exists for the
 * opposite job: proving that a directory the tool must never write to holds
 * exactly the files it held before, which needs every one of them.
 *
 * @since 0.1.0
 * @private
 */
export const walkAll = (
  root: string
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<string> = []
    const visit = (directory: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (depth > maxDepth) return
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as Array<string>))
        for (const name of names.slice().sort()) {
          const absolute = path.join(directory, name)
          const info = yield* fs.stat(absolute).pipe(Effect.option)
          if (info._tag === "None") continue
          if (info.value.type === "Directory") yield* visit(absolute, depth + 1)
          else if (info.value.type === "File") found.push(relative(root, path, absolute))
        }
      })
    const info = yield* fs.stat(root).pipe(Effect.option)
    if (info._tag === "None" || info.value.type !== "Directory") return []
    yield* visit(root, 0)
    return found.sort()
  })

/**
 * Turns the platform's typed `NotFound` into `None` and leaves every other
 * failure alone.
 *
 * Absence is the one filesystem answer a caller may act on without a person:
 * a file that is not there was not there. A permission error, a disk error,
 * or a path that is a directory is not absence, and treating it as absence is
 * how a rollback deletes a file it was supposed to restore.
 *
 * @since 0.1.0
 * @private
 */
export const optionalNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none()))
  )

/**
 * Reads a UTF-8 file, or `undefined` when it does not exist. Any other
 * failure is an `io` error naming the file.
 *
 * @since 0.1.0
 * @private
 */
export const readIfExists = (
  file: string,
  description: string = file
): Effect.Effect<string | undefined, MigrateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* optionalNotFound(fs.readFileString(file)).pipe(
      Effect.mapError(io(`could not read "${description}"`))
    )
    return Option.isSome(text) ? text.value : undefined
  })

/**
 * Reads a UTF-8 file, or `undefined` when it does not exist or cannot be read.
 *
 * @since 0.1.0
 * @private
 */
export const readOption = (
  file: string
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
  })

/**
 * Reads a UTF-8 file and fails with `io` when it cannot be read.
 *
 * @since 0.1.0
 * @private
 */
export const read = (
  file: string
): Effect.Effect<string, MigrateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file)
  }).pipe(Effect.mapError(io(`could not read "${file}"`)))

/**
 * Reports whether a path exists.
 *
 * @since 0.1.0
 * @private
 */
export const exists = (file: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  })

/**
 * Reports whether a path is a directory.
 *
 * @since 0.1.0
 * @private
 */
export const isDirectory = (file: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file).pipe(Effect.option)
    return info._tag === "Some" && info.value.type === "Directory"
  })

/**
 * The 1-based line and column of a character offset in `source`.
 *
 * @since 0.1.0
 * @private
 */
export const positionAt = (source: string, offset: number): { readonly line: number; readonly column: number } => {
  const before = source.slice(0, Math.max(0, offset))
  const lines = before.split("\n")
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}
