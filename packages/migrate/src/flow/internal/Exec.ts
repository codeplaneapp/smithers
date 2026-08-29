/**
 * Buffered command execution over the permission-aware process spawner.
 *
 * Every command this package runs — `jj`, `git`, an install, a typecheck, a
 * test suite — goes through here, so the `proc:spawn` capability check and the
 * command-line resource stay exactly where the kernel put them. The buffered
 * shape is what a report wants: an exit code and two bounded tails, not a
 * stream nobody kept.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import type { PlatformError } from "effect/PlatformError"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * The buffered result of one command. A non-zero exit is a result, not a
 * failure: verification reports what a command said, and a failed typecheck is
 * the answer rather than an error.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly durationMs: number
}

/**
 * Options for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly timeoutMs?: number | undefined
  /** Present means an argv; absent means a command line for the platform shell. */
  readonly args?: ReadonlyArray<string> | undefined
}

/**
 * A command that never produced an exit code: it could not start, or its
 * timeout cut it off.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecFailure {
  readonly _tag = "ExecFailure"
  readonly command: string
  readonly reason: string
  constructor(command: string, reason: string) {
    this.command = command
    this.reason = reason
  }
}

const gather = (
  handle: ChildProcessHandle
): Effect.Effect<readonly [string, string, number], PlatformError> =>
  // stdout, stderr, and the exit code have to be consumed concurrently: a
  // command that fills a pipe blocks until the pipe is drained, so waiting for
  // exit first would deadlock on any output larger than the buffer.
  Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )

const spawn = (
  command: string,
  options: Options
): Effect.Effect<Result, ExecFailure, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    // The Clock service, not the wall clock: a duration a report prints is a
    // measurement, and a measurement takes its time from the runtime that ran it.
    const started = yield* Clock.currentTimeMillis
    const settings: ChildProcess.CommandOptions = {
      ...(options.args === undefined ? { shell: true } : {}),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env })
    }
    const handle = yield* spawner.spawn(
      options.args === undefined
        ? ChildProcess.make(command, settings)
        : ChildProcess.make(command, [...options.args], settings)
    )
    // Draining runs in its own fiber so the budget can be enforced by joining
    // it: a fiber join is interruptible, where a drain blocked on a pipe the
    // child never closes is not. A command over budget is abandoned rather
    // than asked politely, and the streams are dropped with it.
    const fiber = yield* Effect.forkChild(gather(handle))
    const settled = options.timeoutMs === undefined
      ? Option.some(yield* Fiber.join(fiber))
      : yield* Effect.timeoutOption(Fiber.join(fiber), options.timeoutMs)
    if (Option.isNone(settled)) {
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      return yield* Effect.fail(new ExecFailure(command, `exceeded ${options.timeoutMs}ms`))
    }
    const [stdout, stderr, exitCode] = settled.value
    return { stdout, stderr, exitCode, durationMs: (yield* Clock.currentTimeMillis) - started }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ExecFailure ? error : new ExecFailure(command, String((error as Error).message ?? error))
    )
  )

/**
 * Runs one command and buffers its output.
 *
 * Cancellation is scope closure: the spawn is scoped, so an interrupted fiber
 * — including the one a `timeoutMs` interrupts — terminates the process rather
 * than leaking it.
 *
 * @category execution
 * @since 0.1.0
 */
export const run = (
  command: string,
  options: Options = {}
): Effect.Effect<Result, ExecFailure, ChildProcessSpawner> => spawn(command, options)

/**
 * The number of bytes of a command's output the report keeps at each end.
 *
 * @category models
 * @since 0.1.0
 */
export const tailBytes = 12 * 1024

/**
 * The last {@link tailBytes} bytes of a stream, with a marker naming what was
 * dropped so a reader knows the tail is a tail.
 *
 * @category conversions
 * @since 0.1.0
 */
export const tail = (text: string, limit: number = tailBytes): string => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  const kept = new TextDecoder().decode(bytes.slice(bytes.length - limit))
  return `[${bytes.length - limit} earlier bytes omitted]\n${kept}`
}
