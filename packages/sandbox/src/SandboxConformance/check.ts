/**
 * Runs the sandbox session conformance suite.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import * as check_ from "../ProviderConformance/check.ts"
import type { Commands } from "../ProviderConformance/Commands.ts"
import type { Violation } from "../ProviderConformance/Violation.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { commandProvider } from "../Sandbox/commandProvider.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import { posixCommands } from "./posixCommands.ts"

/** Describes an unexpected outcome without leaking a stack into the report. */
const shown = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? JSON.stringify(exit.value) : `a failure: ${String(exit.cause)}`

/**
 * Runs one check against a fresh session, so a check that leaves a session
 * unusable cannot decide the next one.
 */
const inSession = <A>(
  provider: Provider,
  session: string,
  body: (session: Session) => Effect.Effect<A, unknown, never>
): Effect.Effect<Exit.Exit<A, unknown>> => Effect.exit(Effect.scoped(Effect.flatMap(provider.acquire(session), body)))

const output = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Effect.map(
    Effect.all(
      [Stream.mkString(Stream.decodeText(process.stdout)), process.exitCode],
      { concurrency: "unbounded" }
    ),
    ([stdout, code]) => `${stdout}#${code}`
  )

const conformanceBytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])

/**
 * Names the suite's session key and declared capabilities.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
  /** The session key every check acquires. Default `sandbox-conformance`. */
  readonly session?: string | undefined
  /** The command fixture for the delegated spawn checks. Default {@link posixCommands}. */
  readonly commands?: Commands | undefined
  /** Capabilities the provider's sessions are declared to have. */
  readonly provides?: {
    readonly kill?: boolean | undefined
    readonly ping?: boolean | undefined
  } | undefined
}

/**
 * Checks one provider against the `Sandbox` session contract.
 *
 * A provider package runs this in its own test suite and asserts the result
 * is empty, the way `ProviderConformance` is run for spawn-only transports.
 * The file checks state the contract's own obligations — byte round-trips,
 * `not_found` for absence, parent creation, the workdir default, environment
 * delivery, and a working session after release and reacquire — and the
 * spawn checks are the delegated `ProviderConformance` suite over
 * `commandProvider`, so a session provider is held to everything a spawn
 * transport is.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (
  provider: Provider,
  options: CheckOptions = {}
): Effect.Effect<ReadonlyArray<Violation>> =>
  Effect.gen(function*() {
    const session = options.session ?? "sandbox-conformance"
    const roundTrips = yield* inSession(provider, session, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance-bytes.bin`
        yield* live.writeFile(path, conformanceBytes)
        return yield* live.readFile(path)
      }))
    const absent = yield* inSession(provider, session, (live) =>
      Effect.flip(live.readFile(`${live.workdir}/conformance-absent`)))
    const parents = yield* inSession(provider, session, (live) =>
      Effect.gen(function*() {
        const path = `${live.workdir}/conformance/deep/tree/leaf.txt`
        yield* live.writeFile(path, conformanceBytes)
        return yield* live.readFile(path)
      }))
    const workdir = yield* inSession(provider, session, (live) =>
      Effect.gen(function*() {
        const answer = yield* Effect.scoped(Effect.flatMap(live.spawn("pwd", {}), output))
        return { answer, expected: `${live.workdir}\n#0` }
      }))
    const environment = yield* inSession(provider, session, (live) =>
      Effect.scoped(
        Effect.flatMap(
          live.spawn(`printf '%s' "$SANDBOX_CONFORMANCE"`, { env: { SANDBOX_CONFORMANCE: "delivered" } }),
          output
        )
      ))
    const reacquired = yield* Effect.exit(
      Effect.andThen(
        Effect.scoped(Effect.asVoid(provider.acquire(session))),
        Effect.scoped(
          Effect.flatMap(provider.acquire(session), (live) =>
            Effect.scoped(Effect.flatMap(live.spawn("printf 'again'", {}), output)))
        )
      )
    )
    const spawnChecks = yield* check_.check(
      commandProvider(provider, {
        session,
        ...options.provides === undefined ? {} : { provides: options.provides }
      }),
      options.commands ?? posixCommands
    )
    const found: Array<Violation | undefined> = [
      Exit.isSuccess(roundTrips) &&
        roundTrips.value.length === conformanceBytes.length &&
        roundTrips.value.every((byte, index) =>
          byte === conformanceBytes[index]
        )
        ? undefined
        : {
          check: "round-trips-binary-bytes",
          expected: "the written bytes back, unchanged",
          actual: shown(roundTrips)
        },
      Exit.isSuccess(absent) && absent.value instanceof ProviderError && absent.value.code === "not_found"
        ? undefined
        : {
          check: "reports-an-absent-file",
          expected: "a ProviderError with code not_found",
          actual: shown(absent)
        },
      Exit.isSuccess(parents) ? undefined : {
        check: "creates-parent-directories",
        expected: "a write below missing directories to land",
        actual: shown(parents)
      },
      Exit.isSuccess(workdir) && workdir.value.answer === workdir.value.expected ? undefined : {
        check: "runs-in-its-workdir",
        expected: "a bare spawn's working directory to be the session workdir",
        actual: shown(workdir)
      },
      Exit.isSuccess(environment) && environment.value === "delivered#0" ? undefined : {
        check: "delivers-the-environment",
        expected: `stdout "delivered" from the spawn's env`,
        actual: shown(environment)
      },
      Exit.isSuccess(reacquired) && reacquired.value === "again#0" ? undefined : {
        check: "reacquires-its-session",
        expected: "a working session after release and reacquire",
        actual: shown(reacquired)
      }
    ]
    return [
      ...found.filter((violation): violation is Violation =>
        violation !== undefined
      ),
      ...spawnChecks
    ]
  })
