/**
 * Process containment: a kill deadline and a durable record for every child.
 *
 * A cancelled run must leave no process behind. Effect's Node spawner already
 * signals a child's process group when the spawn scope closes, but it signals
 * only `SIGTERM` and then waits for the exit — and with no `forceKillAfter`
 * configured it waits forever. A child that traps `SIGTERM`, or a child whose
 * own children trap it, therefore turns a cancellation into a hung host: the
 * fiber never finishes releasing, so the run never reaches `cancelled` and the
 * process stays on the machine.
 *
 * This module closes that hole in two places. Every command it spawns is
 * rewritten to carry an escalation deadline, so `SIGTERM` is followed by
 * `SIGKILL` after {@link Options.graceMs}; and every started process is
 * recorded in the {@link ProcessLedger.ProcessLedger} and released from it when
 * the scope closes, so a host that dies without running a finalizer leaves a
 * durable record its next incarnation can reap (`ProcessReaper` in
 * `@smthrs/platform-node`).
 *
 * The spawner does not signal anything itself. Killing a live child is
 * Effect's job and it already does it correctly once a deadline exists; this
 * module supplies the deadline and the memory. That leaves nothing
 * platform-specific here, which is why it sits in the kernel beside the
 * `proc:spawn` decorator over the same tag rather than in one platform bundle:
 * `@smthrs/platform-node` and `@smthrs/platform-bun` compose the same
 * middleware.
 *
 * Governing design:
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Schedule from "effect/Schedule"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CommandLine from "./CommandLine.ts"
import * as ProcessLedger from "./ProcessLedger.ts"

/**
 * How long a contained child may take to honour `SIGTERM`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultGraceMs = 2000

/**
 * Containment configuration.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /**
   * Milliseconds between the `SIGTERM` that asks a child to stop and the
   * `SIGKILL` that makes it. Default {@link defaultGraceMs}.
   */
  readonly graceMs?: number | undefined
  /**
   * The platform the host spawner runs on, as `process.platform` spells it.
   * It decides only one thing: whether a command that names no `detached`
   * option gets a process group of its own. Default `"linux"`, which is the
   * detaching branch, because every host bundle in this repository passes its
   * real platform and a caller that supplies a spawner of its own is
   * describing a POSIX-shaped one.
   */
  readonly platform?: string | undefined
}

/**
 * Rewrites a command so releasing it cannot hang.
 *
 * Both legs of a pipeline get the same policy — a pipeline is one action's
 * process tree and a surviving leg is as much of a leak as a surviving
 * child. A policy the caller chose is left alone: a command that already names
 * a `killSignal` or a `forceKillAfter` has an owner who thought about it.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const withContainment = (
  command: ChildProcess.Command,
  options?: Options
): ChildProcess.Command => {
  const graceMs = options?.graceMs ?? defaultGraceMs
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      withContainment(command.left, options),
      withContainment(command.right, options),
      command.options
    )
  }
  return ChildProcess.make(command.command, [...command.args], {
    ...command.options,
    killSignal: command.options.killSignal ?? "SIGTERM",
    forceKillAfter: command.options.forceKillAfter ?? graceMs
  })
}

/**
 * The process group a started child leads, or `null` when it shares the
 * host's.
 *
 * Effect's Node spawner detaches a child that names no `detached` option
 * everywhere EXCEPT win32 (`detached = options.detached ?? platform !==
 * "win32"`), and a detached child leads a group whose id is its own pid. A
 * child that shares the host's group has no group of its own to signal:
 * signalling that group would signal the host. The ledger records the absence
 * rather than a number a reaper could misread, which is why the platform has
 * to reach this function. A win32 record claiming `pgid = pid` would name a
 * group the child does not lead.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const groupOf = (command: ChildProcess.Command, pid: number, platform?: string): number | null => {
  const options = command._tag === "PipedCommand" ? rightmost(command).options : command.options
  const detached = options.detached ?? (platform ?? "linux") !== "win32"
  return detached ? pid : null
}

const rightmost = (command: ChildProcess.Command): ChildProcess.StandardCommand =>
  command._tag === "StandardCommand" ? command : rightmost(command.right)

/**
 * Decorates the process spawner in place with containment and bookkeeping.
 *
 * Compose it over a host spawner layer with `Layer.provide`. It provides the
 * tag it also requires, exactly like `@smthrs/kernel`'s permission decorator,
 * so the two stack in either order over one host implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  options?: Options
): Layer.Layer<ChildProcessSpawner, never, ChildProcessSpawner | ProcessLedger.ProcessLedger> =>
  Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const ledger = yield* ProcessLedger.ProcessLedger
      return makeSpawner(
        Effect.fn("ContainedSpawner.spawn")(function*(command: ChildProcess.Command) {
          // The release finalizer is registered BEFORE the spawn, so scope
          // closure runs it AFTER the spawn's own kill finalizer: finalizers
          // run last-registered-first, and a ledger that announced an exit
          // while the process was still being signalled would be telling the
          // next incarnation to stop looking for something still alive. The
          // slot is empty until the record exists, which is also what makes a
          // spawn that never got recorded a no-op to release.
          const slot: { current?: ProcessLedger.ProcessRecord } = {}
          yield* Effect.addFinalizer(() =>
            slot.current === undefined ? Effect.void : releaseQuietly(ledger, slot.current)
          )
          const handle = yield* spawner.spawn(withContainment(command, options))
          const pid = handle.pid as number
          slot.current = yield* ledger.record({
            pid,
            pgid: groupOf(command, pid, options?.platform),
            commandDigest: CommandLine.render(command)
          }).pipe(
            // A spawn whose record did not commit is precisely the child this
            // module exists to make discoverable, so it is not started: the
            // process is signalled and the caller is told, rather than left
            // running with nothing durable naming it.
            Effect.tapCause(() => Effect.ignore(handle.kill())),
            Effect.mapError(unrecorded)
          )
          return handle
        })
      )
    })
  )

/** The spawn failure a caller sees when the ledger could not record a child. */
const unrecorded = (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: "the process ledger could not record this spawn durably",
    cause
  })

/**
 * Retires a record on scope close, retrying the durable write.
 *
 * A finalizer has nowhere to report a failure, so the retry is the report: an
 * exit that never commits leaves the record inherited, and the next
 * incarnation's reaper finds a pid that is already gone and retires it then.
 * That is the safe direction, and the reason this is the ONE place a ledger
 * failure is logged rather than propagated.
 */
const releaseQuietly = (
  ledger: ProcessLedger.Service,
  record: ProcessLedger.ProcessRecord
): Effect.Effect<void> =>
  ledger.release(record).pipe(
    Effect.retry(Schedule.recurs(2)),
    Effect.catch((error) =>
      Effect.logWarning(`process ledger could not retire ${record.pid}; leaving it for the reaper`, error)
    )
  )
