/**
 * Builds a supervised spawner over a remote provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as PlatformError from "effect/PlatformError"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import {
  type ChildProcessHandle,
  type ChildProcessSpawner,
  make as makeSpawner,
  makeHandle
} from "effect/unstable/process/ChildProcessSpawner"
import { elapsed } from "../internal/deadline.ts"
import { platformFailure } from "../internal/platformReason.ts"
import { makeOpened } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { fromProvider } from "../SandboxHealth/fromProvider.ts"
import type { HealthState } from "../SandboxHealth/HealthState.ts"
import type { Options } from "./Options.ts"
import { loggingReporter } from "./Reporter.ts"
import { SandboxUnhealthy } from "./SandboxUnhealthy.ts"

const MODULE = "ChildProcess"

/** How long a caller-supplied reporter may take before retirement moves on without it. */
const reportWithin = Duration.seconds(30)

/**
 * The failure a retired session hands to everything still running in it.
 *
 * `NotFound` is the reason `RemoteChildProcessSpawner` already maps the
 * provider's `unavailable` code onto, so an action cannot tell a session that
 * refused to open from a session that died under it — and does not need to.
 * Both are the same instruction to a retry policy: try again somewhere else.
 */
const retired = (session: string, reason: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: MODULE,
    method: "supervise",
    description: `sandbox session \`${session}\` was retired: ${reason}`
  })

/** One open session, and the failure that retires everything running in it. */
interface Session {
  readonly scope: Scope.Closeable
  readonly spawner: ChildProcessSpawner["Service"]
  readonly failed: Deferred.Deferred<never, PlatformError.PlatformError>
}

/**
 * Re-reads a handle so its every wait ends when the session is retired.
 *
 * Without this a dead session is silent: the provider's streams stop producing
 * and the exit code never arrives, so the action waits forever instead of
 * failing.
 *
 * A retirement reaches the handle through a second `Deferred`, and the fiber
 * that forwards it asks the process whether it is still running first. That
 * question is the whole trick. A process that already exited is not running in
 * the retired session any more, so nothing is waiting on its guard, and a
 * failure nobody receives is reported as a defect. The question has to be
 * answered on the spot, which is why it is `isRunning` and not the exit code:
 * the fiber that observes an exit code may not have been scheduled yet when a
 * retirement arrives, and a liveness answer that lags is no answer at all.
 *
 * Scope closure cannot do this job. The scope a spawn is given belongs to
 * whoever runs the output stream, and `ChildProcessSpawner.string` runs the
 * stream in the ambient scope, so a guard that waited for scope closure would
 * keep listening for as long as its caller lives.
 */
const guarded = (
  handle: ChildProcessHandle,
  failed: Deferred.Deferred<never, PlatformError.PlatformError>
): Effect.Effect<ChildProcessHandle, never, Scope.Scope> =>
  Effect.gen(function*() {
    const forwarded = yield* Deferred.make<never, PlatformError.PlatformError>()
    yield* Effect.forkScoped(
      Effect.catch(Deferred.await(failed), (error) =>
        Effect.flatMap(
          /* v8 ignore next -- the remote handle answers liveness from a local flag with `Effect.sync`, so the fallback only discharges the error channel `ChildProcessHandle` declares */
          Effect.orElseSucceed(handle.isRunning, () => true),
          (running) => running ? Effect.asVoid(Deferred.fail(forwarded, error)) : Effect.void
        ))
    )
    const dies = Deferred.await(forwarded)
    const guard = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) => Effect.raceFirst(effect, dies)
    const guardStream = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
      Stream.interruptWhen(stream, dies)
    return makeHandle({
      ...handle,
      exitCode: guard(handle.exitCode),
      isRunning: guard(handle.isRunning),
      stdout: guardStream(handle.stdout),
      stderr: guardStream(handle.stderr),
      all: guardStream(handle.all)
    })
  })

/**
 * Builds a spawner that keeps exactly one live provider session.
 *
 * The session opens on the first command, not while the layer is building: a
 * host that never spawns anything must not pay for a sandbox, and a provider
 * that is down must fail the action that needed it rather than the composition
 * root. A heartbeat probes the open session on the configured cadence; an
 * unhealthy verdict retires it, which fails everything running in it and lets
 * the next command open a fresh one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  provider: Provider,
  options: Options
): Effect.Effect<ChildProcessSpawner["Service"], never, Scope.Scope> =>
  Effect.gen(function*() {
    const parent = yield* Scope.Scope
    const reporter = options.reporter ?? loggingReporter
    const tolerance = options.tolerance ?? 1
    const probe: Effect.Effect<HealthState> = options.probe ??
      fromProvider(provider, options.deadline === undefined ? undefined : { deadline: options.deadline }).check
    const held = yield* Ref.make<Session | undefined>(undefined)
    // Bounded on the platform timer, and its outcome discarded whatever it is:
    // a reporter is an observer, and an observer must not be able to hold the
    // one permit every future spawn waits on. The bound is deliberately not an
    // option — a caller who wants a different one wraps their own reporter.
    const report = (event: SandboxUnhealthy) =>
      Effect.catchCause(
        Effect.raceFirst(reporter.unhealthy(event), elapsed(reportWithin)),
        (cause) => Effect.logWarning("the sandbox supervision reporter failed", cause)
      )
    // One session at a time: opening and retiring both rewrite the same cell,
    // and a burst of concurrent spawns must not open a session each.
    const turn = yield* Semaphore.make(1)

    // The heartbeat is the only fiber that clears the held session, and a spawn
    // fills the cell only when it is empty, so the session a verdict retires is
    // the one the probe that produced it ran against.
    //
    // Order and interruptibility are the contract here. Retiring HAS to fail
    // the in-flight commands and close the provider scope: skipping the first
    // leaves every waiter hanging, which is the failure `guarded` exists to
    // prevent, and skipping the second leaks the remote machine. Reporting is
    // observational and is caller-supplied, so it can defect, be interrupted,
    // or never return; sequencing it first put both mandatory operations
    // behind it, and behind the permit every future spawn needs.
    const retire = (session: Session, event: SandboxUnhealthy) =>
      turn.withPermit(Effect.gen(function*() {
        yield* Effect.uninterruptible(Effect.gen(function*() {
          yield* Ref.set(held, undefined)
          yield* Deferred.fail(session.failed, retired(event.session, event.reason))
          yield* Scope.close(session.scope, Exit.void)
        }))
        yield* report(event)
      }))

    const heartbeat = Effect.gen(function*() {
      let unhealthy = 0
      yield* Effect.repeat(
        Effect.gen(function*() {
          const open = yield* Ref.get(held)
          if (open === undefined) {
            unhealthy = 0
            return
          }
          const state = yield* probe
          if (state._tag === "Healthy") {
            unhealthy = 0
            return
          }
          unhealthy += 1
          if (unhealthy < tolerance) return
          const probes = unhealthy
          unhealthy = 0
          yield* retire(
            open,
            new SandboxUnhealthy({
              session: provider.session,
              reason: state.reason,
              ...state.message === undefined ? {} : { message: state.message },
              probes
            })
          )
        }),
        Schedule.spaced(options.interval)
      )
    })

    // `makeOpened`, not `make`: `make` answers with a spawner whose every
    // command fails when the provider refused to open, which is right for a
    // caller holding one session and wrong for a supervisor. Cached as a
    // generation, that spawner replayed the one open failure for the life of
    // the layer, and only a `ping` verdict could ever have cleared it — so a
    // provider without `ping` never opened again at all. A failed open now
    // leaves the cell empty and closes its own scope, and the next command
    // opens a fresh generation.
    const openSession = Effect.gen(function*() {
      const scope = yield* Scope.fork(parent)
      const spawner = yield* Effect.onError(
        Effect.provideService(makeOpened(provider), Scope.Scope, scope),
        () => Scope.close(scope, Exit.void)
      )
      const failed = yield* Deferred.make<never, PlatformError.PlatformError>()
      const session: Session = { scope, spawner, failed }
      yield* Ref.set(held, session)
      return session
    })

    const session = turn.withPermit(
      Effect.flatMap(Ref.get(held), (open) => open === undefined ? openSession : Effect.succeed(open))
    )

    // The heartbeat belongs to the supervisor's own scope, so tearing the
    // supervisor down stops probing before the sessions it probed are gone.
    yield* Effect.forkScoped(heartbeat)

    return makeSpawner(
      Effect.fnUntraced(function*(command) {
        // Acquiring the session and retiring one both hold the permit, so the
        // session handed out here is never one that has already been retired.
        // Everything after that is the guard's job.
        const open = yield* Effect.mapError(session, platformFailure("open", CommandLine.render(command)))
        const handle = yield* open.spawner.spawn(command)
        return yield* guarded(handle, open.failed)
      })
    )
  })
