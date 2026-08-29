/**
 * Buffered shell execution over the permission-aware process spawner.
 *
 * `@smthrs/kernel` used to expose a `Shell` service whose `exec` returned a
 * buffered `{ stdout, stderr, exitCode }`. The kernel replaced it with
 * `ChildProcessSpawner`, Effect's own process boundary, which streams and has
 * no buffered form. This module is the buffered form the shell flows still
 * want, expressed in terms of the spawner so the `proc:spawn` capability check
 * and the command-line resource stay exactly where the kernel put them.
 *
 * Commands run through the platform shell (`shell: true`), matching the old
 * service: the flows take a command *line*, not an argv.
 *
 * @since 0.1.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

/**
 * Failure codes a buffered execution can report, matching the codes the
 * removed kernel `Shell` used so handler-level mapping is unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export const ExecErrorCode = Schema.Literals(["timeout", "spawn_error"])

/**
 * Failure codes a buffered execution can report.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecErrorCode = typeof ExecErrorCode.Type

/**
 * A command that never produced an exit code.
 *
 * A non-zero exit is a successful {@link ExecResult}, not a failure; this
 * error is reserved for a command that could not start or was cut off by its
 * timeout.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecError extends Schema.TaggedError<ExecError>()("flows/std/ExecError", {
  code: ExecErrorCode,
  message: Schema.String
}) {}

/**
 * The buffered result of one command.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Options accepted by {@link exec}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly timeoutMs?: number | undefined
  /**
   * The program's arguments. Present means an argv, absent means a command
   * line for the platform shell. An argv is how a payload reaches a program
   * without being quoted into a string: nothing between here and `execve`
   * re-parses it.
   */
  readonly args?: ReadonlyArray<string> | undefined
  /**
   * Text written to the program's standard input, as data. A script delivered
   * this way is never quoted, escaped, or heredoc-terminated, which is the
   * whole point: quoting corruption cost the measured SWE-bench program twelve
   * probe failures and one instance's most expensive frame.
   */
  readonly stdin?: string | undefined
}

const unbounded = (
  command: string,
  options: ExecOptions
): Effect.Effect<ExecResult, ExecError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const settings: ChildProcess.CommandOptions = {
      ...(options.args === undefined ? { shell: true } : {}),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined
        ? {}
        : { stdin: Stream.make(new TextEncoder().encode(options.stdin)) })
    }
    const handle = yield* spawner.spawn(
      options.args === undefined
        ? ChildProcess.make(command, settings)
        : ChildProcess.make(command, [...options.args], settings)
    )
    // stdout, stderr, and the exit code have to be consumed concurrently: a
    // command that fills a pipe blocks until the pipe is drained, so waiting
    // for exit first would deadlock on any output larger than the buffer.
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, exitCode: exitCode }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ExecError ? error : new ExecError({
        code: "spawn_error",
        message: `exec: ${command}: ${error.message}`
      })
    )
  )

/**
 * Runs a command line through the platform shell and buffers its output.
 *
 * Cancellation is scope closure: the spawn is scoped, so an interrupted fiber
 * — including the one a `timeoutMs` interrupts — terminates the process rather
 * than leaking it.
 *
 * @category execution
 * @since 0.1.0
 */
export const exec = (
  command: string,
  options: ExecOptions = {}
): Effect.Effect<ExecResult, ExecError, ChildProcessSpawner.ChildProcessSpawner> =>
  options.timeoutMs === undefined
    ? unbounded(command, options)
    : Effect.timeoutOrElse(unbounded(command, options), {
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new ExecError({
            code: "timeout",
            message: `exec: \`${command}\` exceeded ${options.timeoutMs}ms`
          })
        )
    })
