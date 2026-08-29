/**
 * Constructs a `FileSystem` over a ZenFS-shaped backend.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import { fileInfo } from "./fileInfo.ts"
import { platformError } from "./platformError.ts"
import { streamFile } from "./streamFile.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Reads a whole file as bytes through the backend.
 *
 * @private
 */
const readBytes = (fs: ZenFsPromisesLike, path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readFile(path), catch: platformError("readFile", path) })

/**
 * `flag` is forwarded rather than dropped: both ZenFS and `node:fs/promises`
 * honour it, and silently turning an `"a"` into a truncating write would lose
 * the caller's data. `"wx"` surfaces as `EEXIST`, which {@link platformError}
 * already normalizes to `AlreadyExists`.
 *
 * @private
 */
const writeBytes = (
  fs: ZenFsPromisesLike,
  path: string,
  data: Uint8Array,
  options?: { readonly flag?: string | undefined; readonly mode?: number | undefined }
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(path, data, {
        ...(options?.flag === undefined ? {} : { flag: options.flag }),
        ...(options?.mode === undefined ? {} : { mode: options.mode })
      }),
    catch: platformError("writeFile", path)
  })

/**
 * The refusal every deliberately unsupported operation answers with.
 *
 * `FileSystem.makeNoop` fails most unimplemented operations with `NotFound`
 * but hardcodes the `makeTemp*` family to a defect, so the documented
 * NotFound contract for those four has to be wired explicitly.
 *
 * @private
 */
const unsupported = (method: string): Effect.Effect<never, PlatformError.PlatformError> =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method,
      description: "the browser backend does not support this operation",
      pathOrDescriptor: method
    })
  )

/**
 * Constructs a `FileSystem` over a ZenFS-shaped backend.
 *
 * Only the operations a browser backend can actually serve are wired up.
 * Everything else answers with `FileSystem.makeNoop`'s refusal — a `NotFound`
 * failure — which is the honest answer for a backend that has no symlinks,
 * writable handles, or watchers: `chmod`, `chown`, `copy`, `copyFile`, `glob`,
 * `link`, `symlink`, `readLink`, `open`, `rename`, `sink`, `truncate`,
 * `utimes`, `watch`, and the `makeTemp*` family all fail rather than pretend.
 * The `makeTemp*` four are wired explicitly because `makeNoop` hardcodes them
 * to a defect rather than the `NotFound` failure this contract documents.
 * `sink` is in that list because the slice has no writable file handle to
 * append through, so there is no way to honour its incremental contract.
 * Reads use bounded file-handle chunks rather than loading the whole file.
 * `readFileString` and `writeFileString` are wired explicitly, because
 * `makeNoop` — unlike `make` — does not derive them. Each gap that
 * turns out to matter becomes a ticket, not a silently-wrong implementation
 * (`Concepts/Tickets Not Exceptions.md`).
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (fs: ZenFsPromisesLike): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    makeTempDirectory: () => unsupported("makeTempDirectory"),
    makeTempDirectoryScoped: () => unsupported("makeTempDirectoryScoped"),
    makeTempFile: () => unsupported("makeTempFile"),
    makeTempFileScoped: () => unsupported("makeTempFileScoped"),
    readFile: (path) => readBytes(fs, path),
    stream: (path, options) => streamFile(fs, path, options),
    writeFile: (path, data, options) => writeBytes(fs, path, data, options),
    /**
     * `makeNoop` does not derive the string helpers from `readFile`/`writeFile`
     * the way `make` does — it hardcodes both to a `NotFound` failure — so they
     * have to be wired explicitly, with the same encode/decode error handling
     * effect's own `make` uses.
     */
    readFileString: (path, encoding) =>
      Effect.flatMap(readBytes(fs, path), (bytes) =>
        Effect.try({
          try: () => new TextDecoder(encoding).decode(bytes),
          catch: (cause) =>
            PlatformError.badArgument({
              module: "FileSystem",
              method: "readFileString",
              description: "invalid encoding",
              cause
            })
        })),
    writeFileString: (path, data, options) =>
      Effect.flatMap(
        Effect.try({
          try: () => new TextEncoder().encode(data),
          catch: (cause) =>
            PlatformError.badArgument({
              module: "FileSystem",
              method: "writeFileString",
              description: "could not encode string",
              cause
            })
        }),
        (bytes) => writeBytes(fs, path, bytes, options)
      ),
    makeDirectory: (path, options) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () => fs.mkdir(path, { recursive: options?.recursive ?? false }),
          catch: platformError("makeDirectory", path)
        })
      ),
    readDirectory: (path) =>
      Effect.tryPromise({ try: () => fs.readdir(path), catch: platformError("readDirectory", path) }),
    stat: (path) =>
      Effect.map(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("stat", path) }),
        fileInfo
      ),
    realPath: (path) =>
      Effect.as(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("realPath", path) }),
        path
      ),
    remove: (path, options) =>
      Effect.tryPromise({
        try: () =>
          fs.rm(path, {
            recursive: options?.recursive ?? false,
            force: options?.force ?? false
          }),
        catch: platformError("remove", path)
      }),
    access: (path) =>
      Effect.asVoid(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("access", path) })
      ),
    /**
     * `makeNoop` hardcodes `exists` to `false` (it does not derive it from
     * `access` the way `make` does), so it has to be overridden explicitly.
     */
    exists: (path) =>
      Effect.match(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("exists", path) }),
        { onFailure: () => false, onSuccess: () => true }
      )
  })
