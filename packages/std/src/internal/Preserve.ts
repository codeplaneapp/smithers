/**
 * Writes that leave a file's metadata exactly as they found it.
 *
 * A patch is content. Five graded SWE-bench patches nonetheless shipped
 * `100644 → 100755` mode sections around their real edits, and a grader that
 * reverse-applies a patch can fail on a mode hunk the agent never intended. The
 * permission bits are not this library's to change, so a write that changes them
 * changes them back.
 *
 * The check is a comparison rather than an unconditional `chmod`: on a
 * filesystem where truncating a write already preserves the bits — which is most
 * of them — nothing is called at all, and a host with no `chmod` (a browser
 * filesystem) is only reached when the bits actually moved.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"

const permissions = 0o7777

const mode = (
  fileSystem: FileSystem.FileSystem,
  path: string
): Effect.Effect<number | undefined> =>
  fileSystem.stat(path).pipe(
    Effect.map((info) => info.mode & permissions),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * Replaces a file's text, restoring its permission bits if the write moved them.
 *
 * @category filesystem
 * @since 0.1.0
 */
export const writeFileString = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  content: string
): Effect.Effect<void, PlatformError.PlatformError> =>
  around(fileSystem, path, fileSystem.writeFileString(path, content))

/**
 * Replaces a file's bytes, restoring its permission bits if the write moved
 * them.
 *
 * `apply_patch` writes bytes rather than text and is reached by the same agent,
 * for the same reason, on the same files as `edit`. A mode section in a patch is
 * noise wherever it comes from, so both doors have the same rule.
 *
 * @category filesystem
 * @since 0.1.0
 */
export const writeFile = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  content: Uint8Array
): Effect.Effect<void, PlatformError.PlatformError> => around(fileSystem, path, fileSystem.writeFile(path, content))

/** Reads the bits, runs the write, and puts the bits back when they moved. */
const around = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  write: Effect.Effect<void, PlatformError.PlatformError>
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const before = yield* mode(fileSystem, path)
    yield* write
    if (before === undefined) return
    const after = yield* mode(fileSystem, path)
    if (after !== undefined && after !== before) yield* Effect.ignore(fileSystem.chmod(path, before))
  })
