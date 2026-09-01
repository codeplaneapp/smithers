/**
 * Shared contract suite for complete Host bundles.
 *
 * This module is emitted as ESM, CJS, and declarations and exported from
 * `@smthrs/kernel/test/contract`. It intentionally has a Vitest peer because
 * it registers a reusable behavioral contract for third-party Host bundles.
 *
 * @since 0.1.0
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { describe, expect, it } from "@effect/vitest"
import * as JjService from "@smthrs/jj"
import type { Jj, JjErrorCode } from "@smthrs/jj"
import { Deferred, Effect, Fiber, FileSystem, type Layer, Option, Path, Stream } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A capability that must fail with a stable typed code.
 *
 * @category models
 * @since 0.1.0
 */
export interface FailureCapability<Code extends string> {
  readonly expected: "failure"
  readonly code: Code
}

/**
 * Successful filesystem contract options.
 *
 * `scratchPath` is required only for hosts whose filesystem does not accept an
 * OS temp path — an in-memory double, say. Omitting it takes
 * {@link defaultScratchPath}, which is process-scoped and outside the working
 * tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileSystemSuccess {
  readonly expected: "success"
  readonly scratchPath?: string | undefined
  /** Operations this otherwise available host deliberately refuses. */
  readonly unsupported?: Partial<Record<FileSystemOperation, string>> | undefined
}

/** Every method on Effect's closed filesystem service. */
export const FileSystemOperations = [
  "access",
  "copy",
  "copyFile",
  "chmod",
  "chown",
  "glob",
  "exists",
  "link",
  "makeDirectory",
  "makeTempDirectory",
  "makeTempDirectoryScoped",
  "makeTempFile",
  "makeTempFileScoped",
  "open",
  "readDirectory",
  "readFile",
  "readFileString",
  "readLink",
  "realPath",
  "remove",
  "rename",
  "sink",
  "stat",
  "stream",
  "symlink",
  "truncate",
  "utimes",
  "watch",
  "writeFile",
  "writeFileString"
] as const

/** One method of Effect's closed filesystem service. */
export type FileSystemOperation = typeof FileSystemOperations[number]

/**
 * Successful Path contract expectation.
 *
 * @category models
 * @since 0.1.0
 */
export interface PathSuccess {
  readonly expected: "success"
}

/**
 * Successful `ChildProcessSpawner` contract options.
 *
 * Defaults are POSIX commands suitable for Node and Bun. In-process browser
 * doubles can provide their own scripted commands and expected output.
 *
 * There is no timeout case: a wall-clock budget is `Effect.timeout` around any
 * effect, not a per-spawn option, so there is nothing host-specific left to
 * assert.
 *
 * @category models
 * @since 0.1.0
 */
export interface ChildProcessSuccess {
  readonly expected: "success"
  readonly execCommand?: ChildProcess.Command | undefined
  readonly expectedStdout?: string | undefined
  readonly streamCommand?: ChildProcess.Command | undefined
  readonly expectedStreamText?: string | undefined
  /** A command carrying `cwd` and `env` options through to the child. */
  readonly optionsCommand?: ChildProcess.Command | undefined
  readonly expectedOptionsStdout?: string | undefined
  /**
   * How the host handles a command fed from a `stdin` stream: the expected
   * stdout when it supports one, or the typed code when it does not.
   */
  readonly stdin?:
    | { readonly command: ChildProcess.Command; readonly expectedStdout: string }
    | FailureCapability<string>
    | undefined
  readonly interruptCommand?: ChildProcess.Command | undefined
}

/**
 * Successful Jj contract expectation.
 *
 * @category models
 * @since 0.1.0
 */
export interface JjSuccess {
  readonly expected: "success"
}

/**
 * Successful HTTP contract probe.
 *
 * A request is explicit so the shared suite never invents a live network call.
 *
 * @category models
 * @since 0.1.0
 */
export interface HttpClientSuccess {
  readonly expected: "success"
  readonly request: HttpClientRequest.HttpClientRequest
  readonly assertResponse: (response: HttpClientResponse.HttpClientResponse) => void
}

/**
 * Complete capability expectations for the closed five-tag Host surface.
 * Unsupported capabilities are asserted with their code and are never skipped.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostContractCapabilities {
  readonly fileSystem: FileSystemSuccess | FailureCapability<string>
  readonly path: PathSuccess | FailureCapability<string>
  readonly childProcess: ChildProcessSuccess | FailureCapability<string>
  readonly jj: JjSuccess | FailureCapability<JjErrorCode>
  readonly httpClient: HttpClientSuccess | FailureCapability<string>
}

/**
 * The full layer output required by the contract.
 *
 * @category models
 * @since 0.1.0
 */
export type HostContractLayer = Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient,
  unknown
>

/**
 * Normalizes the code a Host failure is identified by, across the three shapes
 * the closed surface produces: a `code` field (`JjError`), a nested
 * `reason._tag` (`PlatformError`, `HttpClientError`), and a bare `_tag`.
 * Anything else is uncoded.
 *
 * @category testing
 * @since 0.1.0
 */
export const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  if (
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    typeof error.reason._tag === "string"
  ) {
    return error.reason._tag
  }
  if ("_tag" in error && typeof error._tag === "string") return error._tag
  return undefined
}

/**
 * Asserts that `effect` fails with `code`. Succeeding is itself a contract
 * violation: a capability declared unsupported must never quietly work.
 *
 * @category testing
 * @since 0.1.0
 */
export const assertFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  code: string
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        expect(errorCode(error)).toBe(code)
      },
      onSuccess: () => {
        throw new Error(`expected typed failure ${code}`)
      }
    })
  )

let scratchSeq = 0

/**
 * Allocates the scratch file path a contract bundle writes through when the
 * caller declares no `scratchPath` of its own.
 *
 * The path is absolute under the OS temp directory and scoped by both process
 * id and an allocation counter. A repo-relative default would put the file in
 * the working tree, where it is neither ignored by git nor private to one test
 * process: concurrent `vitest run` invocations would then race the same path,
 * and the suite's `ensuring` remove could truncate a sibling's file between its
 * write and its read.
 *
 * @category testing
 * @since 0.1.0
 */
export const defaultScratchPath = (suite: string): string => {
  const slug = suite.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "host"
  // Ambient `process.pid` on purpose: this is a Node-only test harness that
  // must name a path unique to THIS operating-system process before any layer
  // exists to ask. Injecting it would only move the same read one frame out.
  return join(tmpdir(), `flows-host-contract-${process.pid}-${++scratchSeq}-${slug}`)
}

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: HostContractLayer
): Effect.Effect<A, E | unknown> => effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E | unknown>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: HostContractLayer) => provide(effect, layer)

const unsupported = ChildProcess.make("host-contract-unsupported")

const unsupportedChildProcess = (operation: "string" | "stream", code: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    yield* operation === "stream"
      ? assertFailure(Stream.runDrain(spawner.streamString(unsupported)), code)
      : assertFailure(spawner.string(unsupported), code)
  })

const fileSystemProbe = (
  fs: FileSystem.FileSystem,
  operation: FileSystemOperation,
  root: string
): Effect.Effect<unknown, unknown, unknown> => {
  const at = (name: string): string => `${root}/${operation}-${name}`
  const source = `${root}/source.txt`
  const bytes = new TextEncoder().encode("host-contract")
  switch (operation) {
    case "access":
      return fs.access(source)
    case "copy":
      return fs.copy(source, at("copy.txt"))
    case "copyFile":
      return fs.copyFile(source, at("copy-file.txt"))
    case "chmod":
      return fs.chmod(source, 0o600)
    case "chown":
      return Effect.flatMap(fs.stat(source), (info) =>
        fs.chown(
          source,
          Option.getOrElse(info.uid, () => 0),
          Option.getOrElse(info.gid, () => 0)
        ))
    case "glob":
      return fs.glob("**/*.txt", { root })
    case "exists":
      return Effect.tap(fs.exists(source), (exists) => Effect.sync(() => expect(exists).toBe(true)))
    case "link":
      return fs.link(source, at("hard-link.txt"))
    case "makeDirectory":
      return fs.makeDirectory(at("directory"), { recursive: true })
    case "makeTempDirectory":
      return Effect.flatMap(fs.makeTempDirectory({ directory: root }), (path) => fs.remove(path, { recursive: true }))
    case "makeTempDirectoryScoped":
      return Effect.scoped(
        Effect.flatMap(fs.makeTempDirectoryScoped({ directory: root }), (path) => fs.exists(path))
      )
    case "makeTempFile":
      return Effect.flatMap(fs.makeTempFile({ directory: root }), (path) => fs.remove(path, { force: true }))
    case "makeTempFileScoped":
      return Effect.scoped(
        Effect.flatMap(fs.makeTempFileScoped({ directory: root }), (path) => fs.exists(path))
      )
    case "open":
      return Effect.scoped(Effect.flatMap(fs.open(source, { flag: "r" }), (file) => file.stat))
    case "readDirectory":
      return fs.readDirectory(root)
    case "readFile":
      return fs.readFile(source)
    case "readFileString":
      return fs.readFileString(source)
    case "readLink": {
      const link = at("symbolic-link.txt")
      return fs.symlink(source, link).pipe(Effect.andThen(fs.readLink(link)))
    }
    case "realPath":
      return fs.realPath(source)
    case "remove": {
      const path = at("remove.txt")
      return fs.writeFile(path, bytes).pipe(Effect.andThen(fs.remove(path)))
    }
    case "rename": {
      const from = at("rename-from.txt")
      return fs.writeFile(from, bytes).pipe(Effect.andThen(fs.rename(from, at("rename-to.txt"))))
    }
    case "sink":
      return Stream.run(Stream.succeed(bytes), fs.sink(at("sink.txt")))
    case "stat":
      return fs.stat(source)
    case "stream":
      return Stream.runDrain(fs.stream(source))
    case "symlink":
      return fs.symlink(source, at("symlink.txt"))
    case "truncate": {
      const path = at("truncate.txt")
      return fs.writeFile(path, bytes).pipe(Effect.andThen(fs.truncate(path, 1)))
    }
    case "utimes":
      return fs.utimes(source, new Date(0), new Date(0))
    case "watch":
      return Effect.gen(function*() {
        const watched = yield* Stream.runHead(fs.watch(root)).pipe(
          Effect.timeout("5 seconds"),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* fs.writeFile(at("watched.txt"), bytes)
        yield* Fiber.join(watched)
      })
    case "writeFile":
      return fs.writeFile(at("write.txt"), bytes)
    case "writeFileString":
      return fs.writeFileString(at("write-string.txt"), "host-contract")
  }
}

/** The default stdin probe: echo back one line read from the child's stdin. */
const defaultStdinCommand = ChildProcess.make(
  "/bin/sh",
  ["-c", `read host_contract_input; printf '%s' "$host_contract_input"`],
  { stdin: Stream.fromArray([new TextEncoder().encode("stdin\n")]) }
)

/**
 * Registers the shared Host contract with Vitest.
 *
 * Every invocation creates ten cases: complete service presence,
 * FileSystem, Path, five child-process lifecycle cases, Jj, and
 * HttpClient.
 *
 * @category testing
 * @since 0.1.0
 */
export const runHostContract = (
  name: string,
  layer: HostContractLayer,
  caps: HostContractCapabilities
): void => {
  const fileSystemCap = caps.fileSystem
  const pathCap = caps.path
  const childProcessCap = caps.childProcess
  const jjCap = caps.jj
  const httpClientCap = caps.httpClient
  const scratchPath = fileSystemCap.expected === "success"
    ? fileSystemCap.scratchPath ?? defaultScratchPath(name)
    : ""

  describe(`${name} Host contract`, () => {
    it.live("provides every tag in the closed Host service list", () =>
      run(
        Effect.gen(function*() {
          yield* FileSystem.FileSystem
          yield* Path.Path
          yield* ChildProcessSpawner
          yield* JjService.Jj
          yield* HttpClient
        }),
        layer
      ))

    it.live("declares every FileSystem operation", () =>
      run(
        fileSystemCap.expected === "failure"
          ? Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* Effect.forEach(
              FileSystemOperations,
              (operation) => assertFailure(
                fileSystemProbe(fs, operation, "/host-contract/unsupported"),
                fileSystemCap.code
              ),
              { discard: true }
            )
          })
          : Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const root = scratchPath
            const bytes = new TextEncoder().encode("host-contract")
            yield* Effect.gen(function*() {
              yield* fs.makeDirectory(root, { recursive: true })
              yield* fs.writeFile(`${root}/source.txt`, bytes)
              yield* Effect.forEach(
                FileSystemOperations,
                (operation) => {
                  const probe = fileSystemProbe(fs, operation, root)
                  const code = fileSystemCap.unsupported?.[operation]
                  return code === undefined ? probe : assertFailure(probe, code)
                },
                { discard: true }
              )
            }).pipe(
              Effect.ensuring(fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore))
            )
          }),
        layer
      ))

    it.live("declares Path behavior", () =>
      run(
        pathCap.expected === "failure"
          ? Effect.gen(function*() {
            const path = yield* Path.Path
            yield* assertFailure(
              Effect.try({
                try: () => path.fromFileUrl(new URL("file:///host-contract/value")),
                catch: (error) => error
              }),
              pathCap.code
            )
          })
          : Effect.gen(function*() {
            const path = yield* Path.Path
            expect(path.normalize("/host-contract/./nested/../value")).toBe("/host-contract/value")
          }),
        layer
      ))

    it.live("declares buffered child-process behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("string", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const command = childProcessCap.execCommand ?? ChildProcess.make("printf", ["host-contract"])
            expect(yield* spawner.string(command)).toBe(childProcessCap.expectedStdout ?? "host-contract")
            expect(yield* spawner.exitCode(command)).toBe(0)
          }),
        layer
      ))

    it.live("declares child-process streaming behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("stream", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const output = yield* Stream.mkString(
              spawner.streamString(
                childProcessCap.streamCommand ?? ChildProcess.make("printf", ["host-contract-stream"])
              )
            )
            expect(output).toContain(childProcessCap.expectedStreamText ?? "host-contract-stream")
          }),
        layer
      ))

    it.live("declares child-process cwd and env option behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("string", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const output = yield* spawner.string(
              childProcessCap.optionsCommand ??
                ChildProcess.make("/bin/sh", ["-c", `printf '%s' "$HOST_CONTRACT_ENV"`], {
                  cwd: tmpdir(),
                  env: { HOST_CONTRACT_ENV: "env" },
                  extendEnv: true
                })
            )
            expect(output).toBe(childProcessCap.expectedOptionsStdout ?? "env")
          }),
        layer
      ))

    it.live("declares child-process stdin behavior", () =>
      run(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const stdinCap = childProcessCap.expected === "failure"
            ? childProcessCap
            : childProcessCap.stdin ?? { command: defaultStdinCommand, expectedStdout: "stdin" }
          if ("expected" in stdinCap) {
            yield* assertFailure(spawner.string(defaultStdinCommand), stdinCap.code)
            return
          }
          expect(yield* spawner.string(stdinCap.command)).toBe(stdinCap.expectedStdout)
        }),
        layer
      ))

    it.live("declares child-process interruption behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("stream", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const fiber = yield* spawner.streamString(
              childProcessCap.interruptCommand ?? ChildProcess.make("sleep", ["10"])
            ).pipe(
              Stream.concat(Stream.never),
              Stream.runDrain,
              Effect.forkChild({ startImmediately: true })
            )
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
          }),
        layer
      ))

    it.live("declares Jj behavior", () =>
      run(
        jjCap.expected === "failure"
          ? Effect.gen(function*() {
            const jj = yield* JjService.Jj
            yield* assertFailure(jj.status(), jjCap.code)
          })
          : Effect.gen(function*() {
            const jj = yield* JjService.Jj
            expect(typeof (yield* jj.status())).toBe("string")
          }),
        layer
      ))

    it.live("declares HttpClient behavior", () =>
      run(
        httpClientCap.expected === "failure"
          ? Effect.gen(function*() {
            const client = yield* HttpClient
            yield* assertFailure(
              client.execute(HttpClientRequest.get("http://127.0.0.1:1/host-contract")),
              httpClientCap.code
            )
          })
          : Effect.gen(function*() {
            const client = yield* HttpClient
            httpClientCap.assertResponse(
              yield* client.execute(httpClientCap.request)
            )
          }),
        layer
      ))
  })
}
