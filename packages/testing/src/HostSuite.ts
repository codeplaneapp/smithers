/**
 * Runner-agnostic conformance cases for complete Host bundles.
 *
 * The Stratum B descendant of the Smithers testing library: one shared suite
 * parameterized by layer set. Contract sources:
 * `docs/specs/Research/Smithers Testing Library Conversion 2026-07-27.md` §4
 * ("host-layer conformance") and
 * `docs/specs/Concepts/Tickets Not Exceptions.md`.
 *
 * @since 0.0.0
 */
import type { Jj } from "@smthrs/jj"
import { Jj as JjTag } from "@smthrs/jj"
import { Clock, Effect, Fiber, FileSystem, Path, Random, Ref, Stream } from "effect"
import type { Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { CapabilityContractError } from "./TestingError.ts"
import { poisonedClockAndRandom } from "./TestLayers.ts"

/**
 * A declared Host capability expectation.
 *
 * @category models
 * @since 0.0.0
 */
export type CapabilityExpectation =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: string }

/**
 * HTTP requires an explicit probe target so the shared suite never invents a
 * live network call.
 *
 * @since 0.0.0
 * @category models
 */
export type HttpTransportExpectation =
  | {
    readonly supported: true
    readonly request: HttpClientRequest.HttpClientRequest
    readonly expectedStatus: number
  }
  | { readonly supported: false; readonly code: string }

/**
 * Every closed-list Host capability must be declared; omission is not an
 * admission mechanism. `code` is the stable code expected from the named
 * operation when a capability is unsupported.
 *
 * @since 0.0.0
 * @category models
 */
export interface HostProfile {
  /** Scratch file used by the round-trip probe; removed even when the assertion fails. */
  readonly fileSystemScratchPath?: string | undefined
  readonly fileSystem: CapabilityExpectation
  readonly path: CapabilityExpectation
  readonly shell: CapabilityExpectation
  readonly jj: CapabilityExpectation
  readonly httpTransport: HttpTransportExpectation
  readonly clock: CapabilityExpectation
  readonly random: CapabilityExpectation
}

/**
 * A declarative conformance case consumable by any Effect test runner.
 *
 * @category models
 * @since 0.0.0
 */
export interface HostSuiteCase {
  readonly name: string
  readonly run: Effect.Effect<void, unknown>
}

/**
 * The output shape of the public Host bundle contract.
 *
 * `Clock` and `Random` are `Context.Reference`s (their identifier is `never`),
 * so they cannot appear in the layer's output type. The suite enforces them
 * behaviorally instead: the clock and random cases run over a poisoned
 * `Clock`/`Random` base, so a bundle that does not supply its own fails loudly
 * rather than silently using the ambient Effect defaults.
 *
 * @since 0.0.0
 * @category models
 */
export type HostBundle = Layer.Layer<
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Jj
  | HttpClient.HttpClient
>

const failure = (capability: string, operation: string): Effect.Effect<never, CapabilityContractError> =>
  Effect.fail(new CapabilityContractError({ capability, operation }))

const assertEqual = (
  actual: unknown,
  expected: unknown,
  capability: string,
  operation: string
): Effect.Effect<void, CapabilityContractError> =>
  Object.is(actual, expected) ? Effect.void : failure(capability, operation)

const assertCapabilityError = <R>(
  effect: Effect.Effect<unknown, unknown, R>,
  capability: string,
  operation: string,
  code: string
): Effect.Effect<void, CapabilityContractError, R> =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const actual = typeof error === "object" && error !== null && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : typeof error === "object" && error !== null && "reason" in error &&
              typeof error.reason === "object" && error.reason !== null && "_tag" in error.reason &&
              typeof error.reason._tag === "string"
          ? error.reason._tag
          : undefined
        return actual === code
          ? Effect.void
          : Effect.fail(
            new CapabilityContractError({
              capability,
              operation,
              expectedCode: code,
              ...(actual === undefined ? {} : { actualCode: actual })
            })
          )
      },
      onSuccess: () => failure(capability, operation)
    })
  )

const capabilityCode = (expectation: CapabilityExpectation): string => expectation.supported ? "" : expectation.code

const provide = <E, R>(effect: Effect.Effect<void, E, R>, bundle: HostBundle): Effect.Effect<void, E> =>
  effect.pipe(Effect.provide(bundle)) as Effect.Effect<void, E>

/**
 * Provides the bundle over a poisoned `Clock`/`Random` base, so ambient Effect
 * defaults can never silently satisfy a time or randomness probe.
 */
const provideNoAmbient = <E, R>(effect: Effect.Effect<void, E, R>, bundle: HostBundle): Effect.Effect<void, E> =>
  effect.pipe(
    Effect.provide(bundle),
    Effect.provide(poisonedClockAndRandom)
  ) as Effect.Effect<void, E>

/**
 * Produces the shared Host conformance suite. Supported capabilities receive
 * behavioral assertions; unsupported ones must fail the documented operation
 * with its declared typed code.
 *
 * @since 0.0.0
 * @category constructors
 */
export const hostSuite = (bundle: HostBundle, profile: HostProfile): ReadonlyArray<HostSuiteCase> => {
  const scratchPath = profile.fileSystemScratchPath ?? ".flows-host-suite-value.txt"
  const fileSystem = profile.fileSystem.supported
    ? provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()
        yield* Effect.gen(function*() {
          yield* fs.writeFile(scratchPath, encoder.encode("host-suite"))
          const value = decoder.decode(yield* fs.readFile(scratchPath))
          yield* assertEqual(value, "host-suite", "FileSystem", "readFile")
        }).pipe(
          Effect.ensuring(
            fs.remove(scratchPath, { force: true }).pipe(Effect.orDie)
          )
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* assertCapabilityError(
          fs.readFileString("/host-suite/missing.txt"),
          "FileSystem",
          "readFileString",
          capabilityCode(profile.fileSystem)
        )
      }),
      bundle
    )

  const path = profile.path.supported
    ? provide(
      Effect.gen(function*() {
        const path = yield* Path.Path
        yield* assertEqual(
          path.normalize("/host-suite/./nested/../value.txt"),
          "/host-suite/value.txt",
          "Path",
          "normalize"
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const path = yield* Path.Path
        yield* assertCapabilityError(
          path.fromFileUrl(new URL("file:///host-suite/value.txt")),
          "Path",
          "fromFileUrl",
          capabilityCode(profile.path)
        )
      }),
      bundle
    )

  // `Shell` is gone: process spawning is Effect's `ChildProcessSpawner`, which
  // streams rather than buffering, so the probe collects stdout and the exit
  // code concurrently off one handle.
  const unlistedCommand = ChildProcess.make("host-suite-unlisted-command", { shell: true })

  const runUnlisted = Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(unlistedCommand)
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" }
      )
      return { stdout, exitCode: exitCode }
    })
  )

  const shell = profile.shell.supported
    ? provide(
      Effect.gen(function*() {
        const result = yield* runUnlisted
        yield* assertEqual(result.exitCode, 127, "ChildProcessSpawner", "spawn")
        yield* assertEqual(result.stdout, "", "ChildProcessSpawner", "spawn")
      }),
      bundle
    )
    : provide(
      assertCapabilityError(
        runUnlisted,
        "ChildProcessSpawner",
        "spawn",
        capabilityCode(profile.shell)
      ),
      bundle
    )

  const jj = profile.jj.supported
    ? provide(
      Effect.gen(function*() {
        const jj = yield* JjTag
        const status = yield* jj.status()
        if (typeof status !== "string") yield* failure("Jj", "status")
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const jj = yield* JjTag
        yield* assertCapabilityError(jj.status(), "Jj", "status", capabilityCode(profile.jj))
      }),
      bundle
    )

  const httpExpectation = profile.httpTransport
  const httpTransport = httpExpectation.supported
    ? provide(
      Effect.gen(function*() {
        const transport = yield* HttpClient.HttpClient
        const response = yield* Effect.scoped(transport.execute(httpExpectation.request))
        yield* assertEqual(
          response.status,
          httpExpectation.expectedStatus,
          "HttpTransport",
          "execute"
        )
      }),
      bundle
    )
    : provide(
      Effect.gen(function*() {
        const transport = yield* HttpClient.HttpClient
        yield* assertCapabilityError(
          Effect.scoped(transport.execute(HttpClientRequest.get("https://example.invalid/host-suite"))),
          "HttpTransport",
          "execute",
          capabilityCode(httpExpectation)
        )
      }),
      bundle
    )

  const clock = profile.clock.supported
    ? provideNoAmbient(
      Effect.gen(function*() {
        const first = yield* Clock.currentTimeMillis
        const second = yield* Clock.currentTimeMillis
        if (!Number.isInteger(first) || !Number.isInteger(second) || second < first) {
          yield* failure("Clock", "currentTimeMillis")
        }
      }),
      bundle
    )
    : provideNoAmbient(
      assertCapabilityError(
        Clock.currentTimeMillis,
        "Clock",
        "currentTimeMillis",
        capabilityCode(profile.clock)
      ),
      bundle
    )

  const random = profile.random.supported
    ? provideNoAmbient(
      Effect.gen(function*() {
        const value = yield* Random.next
        if (!Number.isFinite(value) || value < 0 || value >= 1) yield* failure("Random", "next")
      }),
      bundle
    )
    : provideNoAmbient(assertCapabilityError(Random.next, "Random", "next", capabilityCode(profile.random)), bundle)

  const cleanup = provide(
    Effect.gen(function*() {
      const released = yield* Ref.make(false)
      const fiber = yield* Effect.scoped(
        Effect.acquireRelease(Effect.void, () => Ref.set(released, true)).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(fiber)
      yield* assertEqual(yield* Ref.get(released), true, "Scope", "interrupt_cleanup")
    }),
    bundle
  )

  return [
    { name: "FileSystem round-trips", run: fileSystem },
    { name: "Path normalizes", run: path },
    { name: "Shell behavior is deterministic", run: shell },
    { name: "Jj has a declared capability result", run: jj },
    { name: "HttpTransport has a declared capability result", run: httpTransport },
    { name: "Clock is monotonic", run: clock },
    { name: "Random produces a valid value", run: random },
    { name: "Scoped resources clean up on fiber interruption", run: cleanup }
  ]
}
