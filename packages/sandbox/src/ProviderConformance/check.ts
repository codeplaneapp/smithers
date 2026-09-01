/**
 * Runs the provider conformance suite.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { layer } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { fromProvider } from "../SandboxHealth/fromProvider.ts"
import { type Commands, defaultStopsWithin } from "./Commands.ts"
import type { Violation } from "./Violation.ts"

/** Describes an unexpected outcome without leaking a stack into the report. */
const shown = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? JSON.stringify(exit.value) : `a failure: ${String(exit.cause)}`

/**
 * Runs one check against a fresh session, so a check that leaves a session
 * unusable cannot decide the next one.
 */
const inSession = <A>(
  provider: Provider,
  effect: Effect.Effect<A, unknown, ChildProcessSpawner>
): Effect.Effect<Exit.Exit<A, unknown>> => Effect.exit(Effect.provide(effect, layer(provider)))

const writesItsOutput = (provider: Provider, commands: Commands): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.string(ChildProcess.make(commands.writes, { shell: commands.shell ?? false })))
    ),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === commands.output ? undefined : {
        check: "writes-its-output",
        expected: `stdout ${JSON.stringify(commands.output)}`,
        actual: shown(exit)
      }
  )

const reportsANonzeroExit = (provider: Provider, commands: Commands): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make(commands.fails, { shell: commands.shell ?? false }))
      )
    ),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === commands.failureCode ? undefined : {
        check: "reports-a-nonzero-exit",
        expected: `exit code ${commands.failureCode}`,
        actual: shown(exit)
      }
  )

const answersAPing = (provider: Provider): Effect.Effect<Violation | undefined> =>
  Effect.map(
    Effect.exit(Effect.provide(fromProvider(provider).check, layer(provider))),
    (exit) =>
      Exit.isSuccess(exit) && exit.value._tag === "Healthy" ? undefined : {
        check: "answers-a-ping",
        expected: "a healthy probe while the session is open",
        actual: shown(exit)
      }
  )

const signalsARunningCommand = (provider: Provider, commands: Commands): Effect.Effect<Violation | undefined> =>
  Effect.map(
    inSession(
      provider,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make(commands.runs, { shell: commands.shell ?? false }))
        yield* handle.kill()
        // A `kill` that RETURNS is not a `kill` that happened. An adapter whose
        // signal goes nowhere satisfies the type and leaves every cancelled
        // action's process running in the sandbox, which is the failure this
        // whole seam exists to prevent, so the process has to be observed
        // stopping.
        //
        // HOW it stopped is not the subject. A provider that reports a
        // signalled process as a failed `exitCode` is as conforming as one that
        // reports a status, so the exit is captured rather than awaited.
        const stopped = yield* Effect.timeoutOption(
          Effect.exit(handle.exitCode),
          commands.stopsWithin ?? defaultStopsWithin
        )
        if (Option.isNone(stopped) || commands.survivor === undefined) return { stopped, survived: false }
        // The handle is the wrapper shell, and a shell that dies while its
        // child lives on satisfies everything above. The second look asks the
        // machine itself whether the command's work is still there.
        const survivor = yield* spawner.exitCode(ChildProcess.make(commands.survivor, { shell: commands.shell ?? false }))
        return { stopped, survived: survivor === 0 }
      }))
    ),
    (exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value.stopped) && !exit.value.survived ? undefined : {
        check: "signals-a-running-command",
        expected: "a declared `kill` stops a live process and everything it started",
        actual: Exit.isSuccess(exit) && Option.isNone(exit.value.stopped)
          ? "the command was still running after the signal"
          : Exit.isSuccess(exit) && exit.value.survived
          ? "the command's work was still running after its handle reported it stopped"
          : shown(exit)
      }
  )

/**
 * Checks one provider against the `Provider` contract.
 *
 * A plugin that ships a provider runs this in its own test suite and asserts
 * the result is empty. The suite is the contract in executable form: what the
 * prose in `RemoteChildProcessSpawner` promises callers, stated as behavior an
 * adapter has to produce. It runs the checks through the real adapter layer,
 * because a provider that satisfies the interface but not the adapter is of no
 * use to a caller.
 *
 * The optional capabilities are checked only when the provider declares them.
 * A provider without `ping` is not asked to answer one, and a provider without
 * `kill` is not asked to signal: those are documented absences, not defects.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (
  provider: Provider,
  commands: Commands
): Effect.Effect<ReadonlyArray<Violation>> =>
  Effect.gen(function*() {
    const found: Array<Violation | undefined> = [
      yield* writesItsOutput(provider, commands),
      yield* reportsANonzeroExit(provider, commands),
      ...provider.ping === undefined ? [] : [yield* answersAPing(provider)],
      ...provider.kill === undefined ? [] : [yield* signalsARunningCommand(provider, commands)]
    ]
    return found.filter((violation): violation is Violation => violation !== undefined)
  })
