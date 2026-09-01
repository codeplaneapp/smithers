/**
 * The just-bash-backed `ChildProcessSpawner` adapter.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { ExitCode, make as makeSpawner, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { captured } from "./captured.ts"
import type { JustBashLike } from "./JustBashLike.ts"

/**
 * A capability the adapter does not provide, reported as a system failure.
 *
 * @private
 */
const unsupported = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, description })

/**
 * Caller input this backend cannot honour, rejected before anything runs.
 *
 * @private
 */
const rejected = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: "ChildProcess", method, description })

/**
 * `true` when the caller wired a `Stream` into stdin, in any of its shapes.
 *
 * @private
 */
const suppliesStdin = (options: ChildProcess.CommandOptions): boolean => {
  const stdin = options.stdin
  if (stdin === undefined || typeof stdin === "string") return false
  return Stream.isStream(stdin) || Stream.isStream(stdin.stream)
}

/**
 * `env` without the `undefined` values just-bash has no way to represent.
 *
 * @private
 */
const resolveEnvironment = (
  options: ChildProcess.CommandOptions
): Record<string, string> | undefined => {
  if (options.env === undefined) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Builds the `ChildProcessSpawner` service over a just-bash interpreter.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const make = (bash: JustBashLike) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    /** Runs are serialized so two interpreters never mutate the mount at once. */
    const gate = Semaphore.makeUnsafe(1)
    let pid = 0

    const resolveWorkingDirectory = Effect.fnUntraced(
      function*(options: ChildProcess.CommandOptions) {
        if (options.cwd === undefined) return undefined
        // Validate that the specified directory is accessible
        yield* fs.access(options.cwd)
        return path.resolve(options.cwd)
      }
    )

    const spawnCommand: (
      command: ChildProcess.Command
    ) => Effect.Effect<
      ChildProcessHandle,
      PlatformError.PlatformError,
      Scope.Scope
    > = Effect.fnUntraced(function*(cmd) {
      if (cmd._tag === "PipedCommand") {
        return yield* Effect.fail(rejected(
          "spawn",
          "just-bash has no process table to pipe between; express the pipeline as a single command line"
        ))
      }
      if (suppliesStdin(cmd.options)) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot supply stdin to a command"))
      }
      if (cmd.options.additionalFds !== undefined && Object.keys(cmd.options.additionalFds).length > 0) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot configure additional file descriptors"))
      }
      if (typeof cmd.options.shell === "string") {
        return yield* Effect.fail(rejected(
          "spawn",
          `just-bash cannot select the requested shell ${cmd.options.shell}`
        ))
      }
      if (cmd.options.detached === true) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot detach a command from the browser tab"))
      }

      const cwd = yield* resolveWorkingDirectory(cmd.options)
      const env = resolveEnvironment(cmd.options)
      const line = CommandLine.render(cmd)

      const completed = yield* Deferred.make<
        Awaited<ReturnType<JustBashLike["exec"]>>,
        PlatformError.PlatformError
      >()
      let running = true
      const execute = gate.withPermit(
        Effect.tryPromise({
          try: (signal) =>
            bash.exec(line, {
              ...(cwd === undefined ? {} : { cwd }),
              ...(env === undefined ? {} : { env }),
              signal
            }),
          catch: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "spawn",
              description: cause instanceof Error ? cause.message : String(cause),
              cause
            })
        })
      )
      const worker = yield* execute.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            running = false
          }).pipe(Effect.andThen(Deferred.done(completed, exit)))
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      const result = Deferred.await(completed)
      const stdout = Stream.unwrap(Effect.map(result, (value) => captured(value.stdout, cmd.options.stdout)))
      const stderr = Stream.unwrap(Effect.map(result, (value) => captured(value.stderr, cmd.options.stderr)))

      return makeHandle({
        pid: ProcessId(++pid),
        exitCode: Effect.map(result, (value) => ExitCode(value.exitCode)),
        isRunning: Effect.sync(() => running),
        kill: () => Fiber.interrupt(worker).pipe(Effect.asVoid),
        stdin: Sink.fail(unsupported("stdin", "just-bash cannot supply stdin to a command")),
        stdout,
        stderr,
        all: Stream.concat(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })

    return makeSpawner(spawnCommand)
  })
