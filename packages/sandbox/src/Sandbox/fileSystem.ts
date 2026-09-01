/**
 * Derives an Effect `FileSystem` from a sandbox session.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import type { ProviderError, ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "./Session.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Provider codes map onto the normalized reasons `PlatformError` already has. */
const REASON: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  aborted: "Unknown",
  timeout: "TimedOut",
  unavailable: "Unknown",
  not_found: "NotFound",
  spawn_error: "Unknown",
  unknown: "Unknown"
}

const providerFailure = (method: string, path: string) =>
(
  error: ProviderError
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: REASON[error.code],
    module: "FileSystem",
    method,
    description: `\`${path}\`: ${error.message}`,
    pathOrDescriptor: path,
    cause: error
  })

/** One probe-decided refusal, in the platform's normalized vocabulary. */
const refused = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string,
  description: string
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    description,
    pathOrDescriptor: path
  })

const notFound = (method: string, path: string): PlatformError.PlatformError =>
  refused("NotFound", method, path, `\`${path}\` does not exist in the sandbox`)

interface ProbeResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const probeFailed = (method: string, path: string) =>
(
  result: ProbeResult
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    description: `\`${path}\`: ${result.stderr.trim() === "" ? `probe exited ${result.code}` : result.stderr.trim()}`,
    pathOrDescriptor: path
  })

/**
 * Runs one probe line in the session and gathers its three outputs. The
 * streams and the exit are consumed concurrently, the way `std`'s own exec
 * adapter does, so a probe whose output outgrows a pipe cannot deadlock.
 */
const probe = (
  session: Session,
  method: string,
  path: string,
  script: string
): Effect.Effect<ProbeResult, PlatformError.PlatformError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(script, {})
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(process.stdout)),
          Stream.mkString(Stream.decodeText(process.stderr)),
          process.exitCode
        ],
        { concurrency: "unbounded" }
      )
      return { code, stdout, stderr }
    })
  ).pipe(Effect.mapError(providerFailure(method, path)))

const emptyInfo = {
  mtime: Option.none<Date>(),
  atime: Option.none<Date>(),
  birthtime: Option.none<Date>(),
  dev: 0,
  ino: Option.none<number>(),
  mode: 0,
  nlink: Option.none<number>(),
  uid: Option.none<number>(),
  gid: Option.none<number>(),
  rdev: Option.none<number>(),
  blksize: Option.none<FileSystem.Size>(),
  blocks: Option.none<number>()
}

const fileTypes: Record<string, FileSystem.File.Info["type"]> = {
  Directory: "Directory",
  File: "File",
  SymbolicLink: "SymbolicLink",
  Unknown: "Unknown"
}

/**
 * Exit codes the probe scripts reserve for outcomes the caller must tell
 * apart, each mapped onto the reason the platform implementations report for
 * the same tree. They sit outside anything the probed utilities answer
 * themselves (0, 1, or 2) and below the shell's own 126/127 markers, so a
 * reserved code can only mean what the script's presence checks decided.
 */
/** The absence marker: the path (or a required source) is not there. */
const absentExit = 9
/** The path already exists where the operation needs absence. */
const alreadyExistsExit = 10
/** The path's kind refuses the operation: a directory in `mv`'s way, a non-directory listed. */
const badResourceExit = 11
/** The path sits behind a directory the session may not search. */
const deniedExit = 12

/**
 * Builds an Effect `FileSystem` over one sandbox session.
 *
 * `readFile` and `writeFile` ride the session's own byte-typed operations.
 * Everything else is derived through portable `sh` probes over
 * `Session.spawn`: POSIX `test`, `wc -c`, `ls -A`, `find`, `mkdir`, `rm`,
 * `mv`, and `dirname`, plus `readlink`/`readlink -f` and `find -mindepth`,
 * which POSIX omits but GNU, busybox, and the BSDs all ship — so any session
 * whose machine has a mainstream `sh` userland serves the whole surface with
 * no adapter work. An adapter that can do better supplies `Session.files`,
 * whose entries override the probes one operation at a time.
 *
 * Failure reasons mirror `NodeFileSystem` wherever a script can tell the
 * outcomes apart: absence is `NotFound`, an occupied `mkdir` target is
 * `AlreadyExists`, a directory in `rename`'s way or a listed non-directory is
 * `BadResource`, and a path an unsearchable ancestor hides fails `exists`
 * with `PermissionDenied`. What a probe cannot classify stays `Unknown`; the
 * one deliberate divergence is `readLink` of an existing non-link, which
 * answers `BadArgument` where Node surfaces its unmapped `EINVAL` as
 * `Unknown`.
 *
 * The derived surface is deliberately partial, on the `makeNoop` base: an
 * operation with no meaningful remote form (a watch, an open file handle, a
 * temp directory) answers with the platform's own refusal rather than a
 * plausible lie, the same stance the workspace transaction's filesystem takes.
 *
 * Relative paths resolve against {@link Session.workdir} before they reach the
 * session or an override, so a body that writes `report.txt` lands in the
 * machine's workspace on every backend; the session contract itself stays
 * absolute-only.
 *
 * Honest limits of the probe dialect: `stat` reports no mode, no times, and no
 * owner (the portable shell cannot name them; its `size` is exact); a
 * directory entry whose name contains a newline is misread, because probe
 * output is line-framed. `stat` follows links the way the platform
 * implementations do, and reports `SymbolicLink` only for a dangling link.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fileSystem = (session: Session): FileSystem.FileSystem => {
  const quote = CommandLine.quote
  const workdir = session.workdir.replace(/\/+$/, "")
  const resolve = (path: string): string => {
    if (path.startsWith("/")) return path
    const trimmed = path.replace(/^(\.\/)+/, "")
    return trimmed === "" || trimmed === "." ? workdir : `${workdir}/${trimmed}`
  }
  const statOf = Effect.fn("Sandbox.fileSystem.stat")(function*(raw: string) {
    const path = resolve(raw)
    const target = quote(path)
    const result = yield* probe(
      session,
      "stat",
      path,
      `if [ -d ${target} ]; then t=Directory; elif [ -f ${target} ]; then t=File; ` +
        `elif [ -h ${target} ]; then t=SymbolicLink; elif [ -e ${target} ]; then t=Unknown; ` +
        `else exit ${absentExit}; fi; s=0; if [ "$t" = File ]; then s=$(wc -c < ${target}); fi; ` +
        `printf '%s %s' "$t" "$s"`
    )
    if (result.code === absentExit) return yield* Effect.fail(notFound("stat", path))
    if (result.code !== 0) return yield* Effect.fail(probeFailed("stat", path)(result))
    // BSD `wc -c` pads its count, so the fields are whitespace-run separated.
    const [type, size] = result.stdout.trim().split(/\s+/)
    return {
      ...emptyInfo,
      /* v8 ignore next -- `split` always yields a first field, so the `type` nullish arm only discharges the indexed-access optional */
      type: fileTypes[type ?? ""] ?? "Unknown",
      size: FileSystem.Size(BigInt(size ?? "0"))
    } satisfies FileSystem.File.Info
  })
  const readFile = (raw: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> => {
    const path = resolve(raw)
    return session.readFile(path).pipe(Effect.mapError(providerFailure("readFile", path)))
  }
  const writeFile = (raw: string, data: Uint8Array): Effect.Effect<void, PlatformError.PlatformError> => {
    const path = resolve(raw)
    return session.writeFile(path, data).pipe(Effect.mapError(providerFailure("writeFile", path)))
  }
  return FileSystem.makeNoop({
    exists: Effect.fn("Sandbox.fileSystem.exists")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // `test -e` answers false for "missing" and "unstatable" alike, but the
      // platform `exists` converts only `NotFound` into `false` — an `EACCES`
      // or `ENOTDIR` from `access(2)` propagates as a failure. When the path
      // is not visible, the script walks up to the deepest ancestor it can
      // stat: a non-directory there is the `ENOTDIR`, an unsearchable
      // directory is the `EACCES` barrier, and a searchable directory proves
      // the path genuinely absent.
      const script = `if [ -e ${target} ]; then exit 0; fi; p=${target}; ` +
        `while [ "$p" != / ]; do p=$(dirname "$p"); if [ -e "$p" ]; then ` +
        `if [ ! -d "$p" ]; then exit ${badResourceExit}; ` +
        `elif [ ! -x "$p" ]; then exit ${deniedExit}; else exit 1; fi; fi; done; exit 1`
      const result = yield* probe(session, "exists", path, script)
      if (result.code === 0) return true
      if (result.code === 1) return false
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "exists", path, `\`${path}\` sits under a non-directory in the sandbox`)
        )
      }
      if (result.code === deniedExit) {
        return yield* Effect.fail(
          refused("PermissionDenied", "exists", path, `\`${path}\` sits under an unsearchable directory in the sandbox`)
        )
      }
      return yield* Effect.fail(probeFailed("exists", path)(result))
    }),
    stat: (path) => statOf(path),
    readFile,
    readFileString: (path) => Effect.map(readFile(path), (bytes) => decoder.decode(bytes)),
    writeFile: (path, data) => writeFile(path, data),
    writeFileString: (path, data) => writeFile(path, encoder.encode(data)),
    makeDirectory: Effect.fn("Sandbox.fileSystem.makeDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      // `mkdir` flattens every refusal to exit 1, so the script decides the
      // reasons the platform implementations report before it runs: an
      // occupied target is `AlreadyExists` (`-h` counts a dangling symlink,
      // which `mkdir` also refuses with `EEXIST`) and a missing parent is
      // `NotFound`. Recursive creation of an existing directory succeeds, as
      // Node's does, and refuses a non-directory occupant.
      const script = options?.recursive === true
        ? `if [ -d ${target} ]; then exit 0; ` +
          `elif [ -e ${target} ]; then exit ${alreadyExistsExit}; else mkdir -p ${target}; fi`
        : `if [ -e ${target} ] || [ -h ${target} ]; then exit ${alreadyExistsExit}; ` +
          `elif [ ! -e "$(dirname ${target})" ]; then exit ${absentExit}; else mkdir ${target}; fi`
      const result = yield* probe(session, "makeDirectory", path, script)
      if (result.code === alreadyExistsExit) {
        return yield* Effect.fail(
          refused("AlreadyExists", "makeDirectory", path, `\`${path}\` already exists in the sandbox`)
        )
      }
      if (result.code === absentExit) return yield* Effect.fail(notFound("makeDirectory", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("makeDirectory", path)(result))
    }),
    readDirectory: Effect.fn("Sandbox.fileSystem.readDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      const recursive = options?.recursive === true
      // A present non-directory is the `ENOTDIR` the platform reports as
      // `BadResource`; only true absence is `NotFound` (a dangling symlink
      // is absent to `readdir`, which follows it, so `-e` is the question).
      const script = recursive
        ? `if [ -d ${target} ]; then find ${target} -mindepth 1; ` +
          `elif [ -e ${target} ]; then exit ${badResourceExit}; else exit ${absentExit}; fi`
        : `if [ -d ${target} ]; then ls -A ${target}; ` +
          `elif [ -e ${target} ]; then exit ${badResourceExit}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "readDirectory", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("readDirectory", path))
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "readDirectory", path, `\`${path}\` is not a directory in the sandbox`)
        )
      }
      if (result.code !== 0) return yield* Effect.fail(probeFailed("readDirectory", path)(result))
      // Sorted for determinism: `ls` and `find` order differ by platform.
      const lines = result.stdout.split("\n").filter((line) => line !== "")
      if (!recursive) return lines.sort()
      const prefix = `${path.replace(/\/+$/, "")}/`
      return lines.map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).sort()
    }),
    remove: Effect.fn("Sandbox.fileSystem.remove")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      const forced = options?.force === true
      const flags = `${options?.recursive === true ? "-r " : ""}${forced ? "-f " : ""}`
      // `rm` answers 1 for everything, so an unforced removal checks presence
      // itself: the platform implementations report a missing path as
      // `NotFound`, and a caller removing idempotently catches exactly that
      // reason. `-h` is part of the question because a dangling symlink is
      // absent to `-e` and still a thing `rm` deletes.
      const script = forced
        ? `rm ${flags}${target}`
        : `if [ -e ${target} ] || [ -h ${target} ]; then rm ${flags}${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "remove", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("remove", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("remove", path)(result))
    }),
    rename: Effect.fn("Sandbox.fileSystem.rename")(function*(rawOld, rawNew) {
      const oldPath = resolve(rawOld)
      const newPath = resolve(rawNew)
      const source = quote(oldPath)
      const destination = quote(newPath)
      // Bare `mv` diverges from `rename(2)`: a missing source is an
      // undistinguished exit 1, and an existing directory destination
      // silently moves the source *into* it. The script probes both before
      // `mv` runs — the missing source is `NotFound` (`-h` keeps a dangling
      // symlink renameable, as it is everywhere), and a directory
      // destination is the `EISDIR` the platform reports as `BadResource`.
      const script = `if [ ! -e ${source} ] && [ ! -h ${source} ]; then exit ${absentExit}; ` +
        `elif [ -d ${destination} ]; then exit ${badResourceExit}; else mv ${source} ${destination}; fi`
      const result = yield* probe(session, "rename", oldPath, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("rename", oldPath))
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "rename", oldPath, `the destination \`${newPath}\` is a directory in the sandbox`)
        )
      }
      if (result.code !== 0) return yield* Effect.fail(probeFailed("rename", oldPath)(result))
    }),
    realPath: Effect.fn("Sandbox.fileSystem.realPath")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // busybox and GNU `readlink -f` answer a missing path with the path
      // itself and exit 0, so presence is probed first; `-e` also treats a
      // dangling symlink as absent, exactly what the platform `realpath`
      // reports.
      const script = `if [ -e ${target} ]; then readlink -f ${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "realPath", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("realPath", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("realPath", path)(result))
      return result.stdout.replace(/\n$/, "")
    }),
    readLink: Effect.fn("Sandbox.fileSystem.readLink")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // `readlink` exits 1 for "missing" and "not a link" alike; `-h` keeps
      // a dangling symlink readable, so the leftover refusal is a present
      // non-link, which stays `BadArgument`.
      const script = `if [ -e ${target} ] || [ -h ${target} ]; then readlink ${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "readLink", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("readLink", path))
      if (result.code !== 0) {
        return yield* Effect.fail(
          PlatformError.badArgument({
            module: "FileSystem",
            method: "readLink",
            description: `\`${path}\` is not a symbolic link in the sandbox`
          })
        )
      }
      return result.stdout.replace(/\n$/, "")
    }),
    ...session.files
  })
}
