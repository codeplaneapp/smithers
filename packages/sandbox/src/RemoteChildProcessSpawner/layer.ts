/**
 * Adapts a remote provider to Effect's `ChildProcessSpawner`.
 *
 * Provider packages adapt their SDK sessions to `Provider`; this module owns
 * the conversion to Effect's `ChildProcessSpawner` contract and its
 * `PlatformError` surface, so a remote session is the same service a local
 * process spawner is. Opening a provider is scoped, so interruption closes the
 * layer scope and runs the provider's cancellation finalizer. No `AbortSignal`
 * crosses this seam.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import type { Provider, RemoteProcess } from "./Provider.ts"
import type { ProviderError, ProviderErrorCode } from "./ProviderError.ts"

const MODULE = "ChildProcess"

/** Provider codes map onto the normalized reasons `PlatformError` already has. */
const REASON: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  aborted: "Unknown",
  timeout: "TimedOut",
  unavailable: "NotFound",
  not_found: "NotFound",
  spawn_error: "Unknown",
  unknown: "Unknown"
}

const platformError = (method: string, command: string) =>
(
  error: ProviderError
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: REASON[error.code],
    module: MODULE,
    method,
    description: `\`${command}\`: ${error.message}`,
    cause: error.cause
  })

const noStdin = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "spawn",
    description: `remote sessions do not pipe stdin to \`${command}\``
  })

const noKill = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "kill",
    description: `remote sessions end \`${command}\` by closing its scope, not by signal`
  })

/** The signal a kill delivers when neither the caller nor the command named one. */
const defaultSignal: ChildProcess.Signal = "SIGTERM"

const rejected = (description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: MODULE, method: "spawn", description })

const suppliesStdin = (options: ChildProcess.CommandOptions): boolean => {
  const stdin = options.stdin
  if (stdin === undefined || typeof stdin === "string") return false
  return Stream.isStream(stdin) || Stream.isStream(stdin.stream)
}

const validateCommand = (command: ChildProcess.Command): Effect.Effect<void, PlatformError.PlatformError> => {
  if (command._tag === "PipedCommand") {
    if (command.options.from !== undefined && command.options.from !== "stdout") {
      return Effect.fail(rejected(`a remote session cannot pipe from ${command.options.from}`))
    }
    if (command.options.to !== undefined && command.options.to !== "stdin") {
      return Effect.fail(rejected(`a remote session cannot pipe to ${command.options.to}`))
    }
    return Effect.andThen(validateCommand(command.left), validateCommand(command.right))
  }
  if (suppliesStdin(command.options)) {
    return Effect.fail(rejected("a remote session cannot supply stdin to a command"))
  }
  if (command.options.additionalFds !== undefined && Object.keys(command.options.additionalFds).length > 0) {
    return Effect.fail(rejected("a remote session cannot configure additional file descriptors"))
  }
  if (typeof command.options.shell === "string") {
    return Effect.fail(rejected(`a remote session cannot select the requested shell ${command.options.shell}`))
  }
  if (command.options.detached === true) {
    return Effect.fail(rejected("a remote session cannot detach a command from its session"))
  }
  return Effect.void
}

const outputStream = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  option: ChildProcess.CommandOutput | { readonly stream?: ChildProcess.CommandOutput | undefined } | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const disposition = option === undefined || typeof option === "string" || Sink.isSink(option)
    ? option
    : option.stream
  if (disposition === undefined || disposition === "pipe" || disposition === "overlapped") return stream
  if (Sink.isSink(disposition)) return Stream.transduce(stream, disposition)
  return Stream.empty
}

const rightmostOptions = (command: ChildProcess.Command): ChildProcess.CommandOptions =>
  command._tag === "StandardCommand" ? command.options : rightmostOptions(command.right)

/**
 * Allocates the `ProcessId` a handle reports.
 *
 * Scoped to one spawner, not to the module. A remote session has no local pid
 * to report, so the number is only ever an intra-spawner handle
 * discriminator — and a module-level `let nextPid = 1` made it process-global
 * state in a repository whose rule is that host access goes through a Layer.
 * Two spawner layers in one process shared a counter, so a handle's id
 * depended on how many processes an unrelated spawner had started.
 */
const pidAllocator = (): () => ProcessId => {
  let nextPid = 1
  return () => ProcessId(nextPid++)
}

const handleOf = (
  command: string,
  child: ChildProcess.Command,
  process: RemoteProcess,
  allocatePid: () => ProcessId,
  provider: Provider
): Effect.Effect<ChildProcessHandle, never, Scope.Scope> =>
  Effect.gen(function*() {
    let running = true
    const rawStdout = Stream.mapError(process.stdout, platformError("stdout", command))
    const rawStderr = Stream.mapError(process.stderr, platformError("stderr", command))
    const options = rightmostOptions(child)
    const stdout = outputStream(rawStdout, options.stdout)
    const stderr = outputStream(rawStderr, options.stderr)
    const completed = yield* Deferred.make<ExitCode, PlatformError.PlatformError>()
    // Either settlement of the provider's exit observation — a code or a
    // failure — means the remote process is gone, so both clear `running`:
    // a handle whose exit could not be read must not keep reporting itself
    // as a live process.
    const observeExit = process.exitCode.pipe(
      Effect.mapError((error) => {
        running = false
        return platformError("exitCode", command)(error)
      }),
      Effect.map((code) => {
        running = false
        return ExitCode(code)
      })
    )
    // Observe completion independently of whether a caller awaits `exitCode`.
    // The Deferred memoizes the one provider observation for every waiter, and
    // the scoped fiber cannot outlive the remote session that owns it.
    yield* Effect.forkScoped(Deferred.into(observeExit, completed))
    const kill = provider.kill
    const signalled: (signal: ChildProcess.Signal) => Effect.Effect<void, PlatformError.PlatformError> =
      kill === undefined
        ? () => Effect.fail(noKill(command))
        : (signal) => Effect.mapError(kill(process, signal), platformError("kill", command))
    if (kill !== undefined) {
      // Closing a process scope asks the provider to stop THAT command before
      // the provider's own release finalizer tears down whatever it owns. A
      // process this side has already seen exit is left alone: the pid it
      // named may belong to someone else by now.
      yield* Effect.addFinalizer(() =>
        running
          ? Effect.ignore(kill(process, rightmostOptions(child).killSignal ?? defaultSignal))
          : Effect.void
      )
    }
    return makeHandle({
      pid: allocatePid(),
      exitCode: Deferred.await(completed),
      isRunning: Effect.sync(() => running),
      kill: (options) => signalled(options?.killSignal ?? rightmostOptions(child).killSignal ?? defaultSignal),
      stdin: Sink.fail(noStdin(command)),
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  })

/**
 * Opens one provider session and adapts it to Effect's `ChildProcessSpawner`.
 *
 * The session is acquired in the caller's scope, so closing that scope runs
 * the finalizer `Provider.open` installed. A session that could not be opened
 * still yields a service: every command it is given fails with the open error,
 * which keeps the failure on the action that tried to run something rather
 * than on whatever was building the layer.
 *
 * `SandboxSupervision` uses this constructor to hold one session at a time.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  provider: Provider
): Effect.Effect<ChildProcessSpawner["Service"], never, Scope.Scope> =>
  provider.open(provider.session).pipe(
    Effect.match({
      onFailure: (error) =>
        makeSpawner((command: ChildProcess.Command) =>
          Effect.fail(platformError("open", CommandLine.render(command))(error))
        ),
      onSuccess: () => {
        const allocatePid = pidAllocator()
        return makeSpawner(
          Effect.fnUntraced(function*(command: ChildProcess.Command) {
            yield* validateCommand(command)
            const rendered = CommandLine.render(command)
            const started = yield* provider.spawn(rendered, {
              cwd: CommandLine.cwd(command),
              env: CommandLine.env(command)
            }).pipe(Effect.mapError(platformError("spawn", rendered)))
            return yield* handleOf(rendered, command, started, allocatePid, provider)
          })
        )
      }
    })
  )

/**
 * Adapts a configured provider to Effect's `ChildProcessSpawner`.
 *
 * Provider acquisition is tied to the layer scope. Interrupting an execution
 * or stream consumer closes that scope and therefore runs the finalizer
 * installed by `Provider.open`.
 *
 * The command reaches the provider as the same rendered line
 * `@smthrs/kernel/ChildProcessSpawner` writes as the `proc:spawn` capability
 * resource, so a grant and the thing it authorizes read the same.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (provider: Provider): Layer.Layer<ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner, make(provider))
