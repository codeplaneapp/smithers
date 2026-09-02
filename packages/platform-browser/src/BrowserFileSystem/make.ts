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
import { readDirectory } from "./readDirectory.ts"
import { realPath } from "./realPath.ts"
import { streamFile } from "./streamFile.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * A private copy of a byte buffer.
 *
 * Bytes cross the backend boundary by value. A backend may hold the buffer it
 * was handed across its own asynchronous commit, and it may answer `readFile`
 * with the array it stores, so the adapter copies in both directions rather
 * than trusting the backend to. `new Uint8Array` rather than `slice`: Node's
 * `Buffer` overrides `slice` to return a view over the same memory.
 *
 * @private
 */
const snapshot = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

/**
 * Reads a whole file as bytes through the backend. The bytes are the
 * backend's own; a caller that keeps them takes a {@link snapshot} first.
 *
 * @private
 */
const readBytes = (fs: ZenFsPromisesLike, path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readFile(path), catch: platformError("readFile", path) })

/**
 * Writes bytes this adapter already owns, so nothing outside it can change
 * them before the backend reads them.
 *
 * `flag` is forwarded rather than dropped: both ZenFS and `node:fs/promises`
 * honour it, and silently turning an `"a"` into a truncating write would lose
 * the caller's data. `"wx"` surfaces as `EEXIST`, which {@link platformError}
 * already normalizes to `AlreadyExists`. Both options arrive as values rather
 * than as the caller's options object, so the effect describes the write the
 * caller asked for when it called, whatever that object holds when it runs.
 *
 * @private
 */
const writeBytes = (
  fs: ZenFsPromisesLike,
  path: string,
  data: Uint8Array,
  flag: string | undefined,
  mode: number | undefined
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(path, data, {
        ...(flag === undefined ? {} : { flag }),
        ...(mode === undefined ? {} : { mode })
      }),
    catch: platformError("writeFile", path)
  })

/**
 * Encodes a string and writes it. A string cannot change under the caller,
 * and the encoder allocates, so the bytes need no further copy.
 *
 * @private
 */
const writeText = (
  fs: ZenFsPromisesLike,
  path: string,
  text: string,
  flag: string | undefined,
  mode: number | undefined
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.flatMap(
    Effect.try({
      try: () => new TextEncoder().encode(text),
      catch: (cause) =>
        PlatformError.badArgument({
          module: "FileSystem",
          method: "writeFileString",
          description: "could not encode string",
          cause
        })
    }),
    (bytes) => writeBytes(fs, path, bytes, flag, mode)
  )

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
 * The permission bits `access` checks a stats `mode` against.
 *
 * A mounted volume has no user identity to check a request against, so the
 * reported `mode` is the whole answer: a path is readable when any read bit
 * is set and writable when any write bit is set. That is stricter than
 * dropping the option, which reports a read-only file as writable.
 *
 * @private
 */
const permitted = (
  mode: number,
  options: { readonly readable?: boolean | undefined; readonly writable?: boolean | undefined }
): boolean =>
  (options.readable !== true || (mode & 0o444) !== 0) &&
  (options.writable !== true || (mode & 0o222) !== 0)

/**
 * The refusal `access` answers with when the path exists but not with the
 * permission the caller asked about.
 *
 * @private
 */
const denied = (path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: path,
    description: "the path does not carry the requested permission"
  })

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
 * The operations that *are* served honour their options rather than dropping
 * them: `readDirectory` walks the tree for `recursive`, `access` answers
 * `readable`/`writable` from the reported mode, `makeDirectory` forwards
 * `mode`, `realPath` canonicalizes, `writeFile` forwards `flag` and `mode`,
 * and `exists` reports `false` only for a path that is absent, propagating
 * every other backend failure the way effect's own derivation does.
 *
 * Bytes and names cross the backend boundary by value. `writeFile` copies
 * `data` and reads `flag` and `mode` when it is called, so the effect it
 * returns describes one write however the caller's buffer or options change
 * before it runs or between retries, and however long the backend holds the
 * bytes it was handed. `readFile` and `readDirectory` return a buffer and an
 * array the caller owns, so a backend that answers from its own storage can
 * neither be corrupted through a result nor change one already returned.
 *
 * The service this builds carries **no** kernel isolation attestation; `layer`
 * is the composition that makes that claim.
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
    readFile: (path) => Effect.map(readBytes(fs, path), snapshot),
    stream: (path, options) => streamFile(fs, path, options),
    writeFile: (path, data, options) => writeBytes(fs, path, snapshot(data), options?.flag, options?.mode),
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
    writeFileString: (path, data, options) => writeText(fs, path, data, options?.flag, options?.mode),
    /**
     * `mode` is forwarded for the same reason `writeBytes` forwards it:
     * creating a directory 0755 when the caller asked for 0700 is a silent
     * permission widening, not a missing feature.
     */
    makeDirectory: (path, options) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () =>
            fs.mkdir(path, {
              recursive: options?.recursive ?? false,
              ...(options?.mode === undefined ? {} : { mode: options.mode })
            }),
          catch: platformError("makeDirectory", path)
        })
      ),
    readDirectory: (path, options) => readDirectory(fs, path, options),
    stat: (path) =>
      Effect.map(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("stat", path) }),
        fileInfo
      ),
    realPath: (path) => realPath(fs, path),
    remove: (path, options) =>
      Effect.tryPromise({
        try: () =>
          fs.rm(path, {
            recursive: options?.recursive ?? false,
            force: options?.force ?? false
          }),
        catch: platformError("remove", path)
      }),
    /**
     * `readable` and `writable` are answered from the reported `mode` rather
     * than dropped: a `writable` check that succeeds on a read-only file is a
     * false green for a caller using `access` as a permission pre-check. `ok`
     * asks for the existence check a bare `access` already performs.
     */
    access: (path, options) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("access", path) }),
        (stats) =>
          options === undefined || permitted(stats.mode, options)
            ? Effect.void
            : Effect.fail(denied(path))
      ),
    /**
     * `makeNoop` hardcodes `exists` to `false` (it does not derive it from
     * `access` the way `make` does), so it has to be overridden explicitly —
     * with effect's own derivation, where only `NotFound` becomes `false` and
     * every other failure propagates. Collapsing a permission refusal into
     * "this path does not exist" answers a question the backend refused.
     */
    exists: (path) =>
      Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("exists", path) }).pipe(
        Effect.as(true),
        Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error))
      )
  })
