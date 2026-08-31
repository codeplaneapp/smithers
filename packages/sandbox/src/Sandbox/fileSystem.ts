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

const notFound = (method: string, path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    description: `\`${path}\` does not exist in the sandbox`,
    pathOrDescriptor: path
  })

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

/** The one absence marker every probe that distinguishes "missing" uses. */
const absentExit = 9

/**
 * Builds an Effect `FileSystem` over one sandbox session.
 *
 * `readFile` and `writeFile` ride the session's own byte-typed operations.
 * Everything else is derived through strictly POSIX `sh` probes over
 * `Session.spawn` — `test`, `wc -c`, `ls -A`, `find`, `mkdir`, `rm`, `mv`,
 * `readlink` — so any session whose machine has a POSIX shell serves the whole
 * surface with no adapter work. An adapter that can do better supplies
 * `Session.files`, whose entries override the probes one operation at a time.
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
      const result = yield* probe(session, "exists", path, `test -e ${quote(path)}`)
      if (result.code === 0) return true
      if (result.code === 1) return false
      return yield* Effect.fail(probeFailed("exists", path)(result))
    }),
    stat: (path) => statOf(path),
    readFile,
    readFileString: (path) => Effect.map(readFile(path), (bytes) => decoder.decode(bytes)),
    writeFile: (path, data) => writeFile(path, data),
    writeFileString: (path, data) => writeFile(path, encoder.encode(data)),
    makeDirectory: Effect.fn("Sandbox.fileSystem.makeDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const flag = options?.recursive === true ? "-p " : ""
      const result = yield* probe(session, "makeDirectory", path, `mkdir ${flag}${quote(path)}`)
      if (result.code !== 0) return yield* Effect.fail(probeFailed("makeDirectory", path)(result))
    }),
    readDirectory: Effect.fn("Sandbox.fileSystem.readDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      const recursive = options?.recursive === true
      const script = recursive
        ? `if [ -d ${target} ]; then find ${target} -mindepth 1; else exit ${absentExit}; fi`
        : `if [ -d ${target} ]; then ls -A ${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "readDirectory", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("readDirectory", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("readDirectory", path)(result))
      // Sorted for determinism: `ls` and `find` order differ by platform.
      const lines = result.stdout.split("\n").filter((line) => line !== "")
      if (!recursive) return lines.sort()
      const prefix = `${path.replace(/\/+$/, "")}/`
      return lines.map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).sort()
    }),
    remove: Effect.fn("Sandbox.fileSystem.remove")(function*(raw, options) {
      const path = resolve(raw)
      const flags = `${options?.recursive === true ? "-r " : ""}${options?.force === true ? "-f " : ""}`
      const result = yield* probe(session, "remove", path, `rm ${flags}${quote(path)}`)
      if (result.code !== 0) return yield* Effect.fail(probeFailed("remove", path)(result))
    }),
    rename: Effect.fn("Sandbox.fileSystem.rename")(function*(rawOld, rawNew) {
      const oldPath = resolve(rawOld)
      const newPath = resolve(rawNew)
      const result = yield* probe(session, "rename", oldPath, `mv ${quote(oldPath)} ${quote(newPath)}`)
      if (result.code !== 0) return yield* Effect.fail(probeFailed("rename", oldPath)(result))
    }),
    realPath: Effect.fn("Sandbox.fileSystem.realPath")(function*(raw) {
      const path = resolve(raw)
      const result = yield* probe(session, "realPath", path, `readlink -f ${quote(path)}`)
      if (result.code !== 0) return yield* Effect.fail(notFound("realPath", path))
      return result.stdout.replace(/\n$/, "")
    }),
    readLink: Effect.fn("Sandbox.fileSystem.readLink")(function*(raw) {
      const path = resolve(raw)
      const result = yield* probe(session, "readLink", path, `readlink ${quote(path)}`)
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
