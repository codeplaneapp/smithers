/** Scoped process execution for build-cli discovery and watch cycles.
 * @since 1.0.0-rc.0
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"

/** A bounded process operation failed, with its original cause retained.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ProcessError extends Error {
  readonly _tag = "ProcessError"
  readonly code: "timed_out" | "cancelled" | "process_failed" | "output_limit" | "cleanup_failed"

  constructor(code: ProcessError["code"], message: string, cause?: unknown) {
    super(message, { cause })
    this.code = code
  }
}

const layer = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
const graceMs = 5000
const reapMs = 5000

// ESRCH alone proves absence. Permission errors must never report successful cleanup.
const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false
    throw new ProcessError("cleanup_failed", `could not signal process group ${pid}`, cause)
  }
}

/** Waits through TERM, KILL, and group disappearance; unknown liveness fails closed.
 * @category execution
 * @since 1.0.0-rc.0
 */
export const stopGroup = async (pid: number): Promise<void> => {
  let lastFailure: unknown
  const exists = () => {
    try {
      return signalGroup(pid, 0)
    } catch (cause) {
      lastFailure = cause
      return true
    }
  }
  const send = async (signal: NodeJS.Signals) => {
    try {
      return signalGroup(pid, signal)
    } catch (cause) {
      // macOS can report EPERM while the final member is being reaped.
      // Yield for that exit, then require ESRCH; an extant group still fails.
      await delay(25)
      if (!exists()) return false
      lastFailure = cause
      return true
    }
  }
  if (!await send("SIGTERM")) return
  const deadline = performance.now() + graceMs
  while (exists()) {
    if (performance.now() >= deadline) {
      await send("SIGKILL")
      break
    }
    await delay(25)
  }
  const reapDeadline = performance.now() + reapMs
  while (exists()) {
    if (performance.now() >= reapDeadline) {
      throw new ProcessError("cleanup_failed", `process group ${pid} still exists after SIGKILL`, lastFailure)
    }
    await delay(25)
  }
}

const stop = (handle: ChildProcessHandle) =>
  process.platform === "win32"
    ? Effect.flatMap(handle.isRunning, (running) =>
      running
        ? handle.kill({ killSignal: "SIGTERM", forceKillAfter: graceMs })
        : Effect.void).pipe(
        Effect.timeoutOrElse({
          duration: graceMs + reapMs,
          orElse: () => Effect.fail(new ProcessError("cleanup_failed", `could not stop process ${handle.pid}`))
        })
      )
    : Effect.tryPromise({ try: () => stopGroup(handle.pid), catch: (cause) => cause })

/** Spawns through the Node service and releases only after the owned group is gone.
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = async (options: {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
  readonly fatalUtf8?: boolean | undefined
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}): Promise<number> => {
  let cleanupFailure: unknown
  const program = Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make(options.command, options.args, {
          cwd: options.cwd,
          env: options.environment,
          extendEnv: options.environment === undefined,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
          killSignal: "SIGTERM",
          forceKillAfter: graceMs
        }))
        // Registered after spawn: this runs BEFORE the service releases its handle.
        // Leader exit is insufficient: descendants may have closed all inherited pipes.
        yield* Effect.addFinalizer(() =>
          stop(handle).pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                cleanupFailure = Cause.squash(cause)
              })
            ),
            Effect.orDie
          )
        )
        return handle
      })
    )
    const consume = (stream: typeof handle.stdout, write: (text: string) => void) => {
      let size = 0
      const decoder = new TextDecoder("utf-8", { fatal: options.fatalUtf8 ?? false })
      return Stream.runForEach(stream, (chunk) =>
        Effect.try({
          try: () => {
            size += chunk.byteLength
            if (options.maxOutputBytes !== undefined && size > options.maxOutputBytes) {
              throw new ProcessError("output_limit", `process output exceeds ${options.maxOutputBytes} bytes`)
            }
            write(decoder.decode(chunk, { stream: true }))
          },
          catch: (cause) => cause
        })).pipe(Effect.andThen(Effect.try({
          try: () => {
            const tail = decoder.decode()
            if (tail !== "") write(tail)
          },
          catch: (cause) => cause
        })))
    }
    const [code] = yield* Effect.all([
      handle.exitCode.pipe(Effect.catch(() => Effect.succeed(1))),
      consume(handle.stdout, options.stdout),
      consume(handle.stderr, options.stderr)
    ], { concurrency: "unbounded" })
    return code
  })
  const bounded = options.timeoutMs === undefined ? program : program.pipe(Effect.timeoutOrElse({
    duration: options.timeoutMs,
    orElse: () => Effect.fail(new ProcessError("timed_out", `process timed out after ${options.timeoutMs}ms`))
  }))
  const result = await Effect.runPromiseExit(bounded.pipe(Effect.scoped, Effect.provide(layer)), {
    signal: options.signal
  })
  if (cleanupFailure !== undefined) {
    throw new ProcessError("cleanup_failed", "process cleanup failed", cleanupFailure)
  }
  if (Exit.isSuccess(result)) return result.value
  if (options.signal?.aborted) throw new ProcessError("cancelled", "process cancelled", options.signal.reason)
  const cause = Cause.squash(result.cause)
  throw cause instanceof ProcessError ? cause : new ProcessError("process_failed", "process execution failed", cause)
}
