/**
 * Deterministic test layer bundles.
 *
 * Contract source:
 * `docs/specs/Research/Smithers Testing Library Conversion 2026-07-27.md` §2 —
 * "a test harness is a layer set".
 *
 * @since 0.0.0
 */
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Kernel from "@smthrs/kernel"
import * as TestHost from "@smthrs/kernel/test/TestHost"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Random from "effect/Random"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type { EngineSubject } from "./EngineSubject.ts"
import { ModelLike } from "./ModelLike.ts"
import { CapabilityContractError } from "./TestingError.ts"

const denied = (capability: string, operation: string): CapabilityContractError =>
  new CapabilityContractError({ capability, operation })

/**
 * The unit-tier bundle: deterministic Host, in-memory Journal, the supplied
 * engine, and the **real** permission kernel (`/kernel` GrantStore over a
 * test Workspace, unattended so sealing violations fail typed instead of
 * suspending). Sealing violations fail in tests exactly as in production.
 *
 * @since 0.0.0
 * @category layers
 */
export const unit = <R, E>(
  engine: Layer.Layer<EngineSubject, E, R>
) => {
  const host = TestHost.TestHost
  const journal = TestJournal.layer()
  const permissions = Kernel.GrantStore.layer({ attended: false }).pipe(
    Layer.provide(Kernel.Workspace.layer("/"))
  )
  return Layer.mergeAll(host, journal, permissions, engine)
}

const poisonedService = <A>(capability: string): A =>
  new Proxy(
    {},
    {
      get: (_target, property) => () => {
        const error = denied(capability, String(property))
        return Effect.fail(error)
      }
    }
  ) as A

const poisonedModel = ModelLike.of({
  stream: () => Stream.fail(new CapabilityContractError({ capability: "model", operation: "stream" }))
})

const poisonedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => {
    throw denied("clock", "currentTimeMillisUnsafe")
  },
  currentTimeMillis: Effect.die(denied("clock", "currentTimeMillis")),
  currentTimeNanosUnsafe: () => {
    throw denied("clock", "currentTimeNanosUnsafe")
  },
  currentTimeNanos: Effect.die(denied("clock", "currentTimeNanos")),
  monotonicTimeNanosUnsafe: () => {
    throw denied("clock", "monotonicTimeNanosUnsafe")
  },
  monotonicTimeNanos: Effect.die(denied("clock", "monotonicTimeNanos")),
  sleep: () => Effect.die(denied("clock", "sleep"))
}

const poisonedRandom: typeof Random.Random.Service = {
  nextIntUnsafe: () => {
    throw denied("random", "nextIntUnsafe")
  },
  nextDoubleUnsafe: () => {
    throw denied("random", "nextDoubleUnsafe")
  }
}

/**
 * Poisoned `Clock` and `Random` references. `Clock` and `Random` are
 * `Context.Reference`s with ambient defaults, so their poisoning cannot appear
 * in a layer's output type; providing this layer beneath a bundle makes any
 * unprovided time or randomness access fail loudly instead of silently using
 * the Effect defaults.
 *
 * @since 0.0.0
 * @category layers
 */
export const poisonedClockAndRandom: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(Clock.Clock)(poisonedClock),
  Layer.succeed(Random.Random)(poisonedRandom)
)

/**
 * A plan-time bundle: Host, Model, Clock, and Random access is rejected
 * instead of reaching a real environment. It deliberately does not provide an
 * engine. Contract source: the "purity poison" standing conformance job in
 * `docs/specs/Research/Smithers Testing Library Conversion 2026-07-27.md` §4.
 *
 * @since 0.0.0
 * @category layers
 */
export const poisoned: Layer.Layer<Kernel.HostServices.HostService | ModelLike> = Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem)(poisonedService<FileSystem.FileSystem>("filesystem")),
  Layer.succeed(Path.Path)(poisonedService<Path.Path>("path")),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    poisonedService<ChildProcessSpawner.ChildProcessSpawner["Service"]>("shell")
  ),
  Layer.succeed(Kernel.Jj.Jj)(poisonedService<Kernel.Jj.Jj>("jj")),
  Layer.succeed(HttpClient.HttpClient)(poisonedService<HttpClient.HttpClient>("httpTransport")),
  Layer.succeed(ModelLike)(poisonedModel),
  poisonedClockAndRandom
)
