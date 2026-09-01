/**
 * The one door into time travel: inspect, fork, rewind.
 *
 * `Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and the
 * effect-handler registry are machinery under `src/internal/`; a caller never
 * names them. This service fronts the three verbs of
 * `docs/specs/Concepts/Time Travel.md` and owns the wiring they used to make
 * the caller thread: the ownership claim a rewind rides, the jj workspace a
 * fork lands in, the compensation-handler registry, and startup recovery of an
 * interrupted rewind.
 *
 * Recovery is not an operation. {@link layer} finishes or rolls back every
 * pending rewind audit while it is being built, so the service only ever hands
 * out a store whose interrupted work is already resolved. The one thing it
 * cannot resolve is an audit whose run another live process still holds: that
 * one is declined and left pending for a later build, rather than closed on
 * the strength of a race. {@link Options.isAlive} decides what "still live"
 * means.
 *
 * The tag key `@smthrs/time-travel/TimeTravel` is durable identity: step keys
 * digest the resolved service set, so renaming it invalidates recorded runs.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import type * as Journal from "@smthrs/journal/Journal"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import type * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { CompensationHandlers } from "./CompensationHandlers.ts"
import { Frame } from "./Frame.ts"
import * as EffectHandlerRegistry from "./internal/EffectHandlerRegistry.ts"
import * as ForkOperation from "./internal/Fork.ts"
import * as Recovery from "./internal/Recovery.ts"
import * as Replay from "./internal/Replay.ts"
import * as Rewind from "./internal/Rewind.ts"
import * as SnapshotProjector from "./internal/SnapshotProjector.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
import type { Fork as ForkRecord, TimeTravelStore } from "./TimeTravelStore.ts"

/**
 * Where in history an operation acts: a run, and a frame inside it.
 *
 * A frame is only an address — the `(lineageId, seq)` journal position — never
 * a snapshot. Every operation derives state by replaying the prefix.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Position = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame
})
/**
 * The value form of {@link Position}.
 *
 * @since 0.1.0
 * @category models
 */
export type Position = typeof Position.Type

/**
 * A pure fold over durable journal evidence, handed to {@link Service.inspect}.
 *
 * @since 0.1.0
 * @category models
 */
export type Projection<S> = Replay.Projection<S>

/**
 * The successful shape of {@link Service.fork}: the child run and its lineage
 * edge back to the parent frame.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkResult = ForkRecord

/**
 * The successful shape of {@link Service.rewind}: the audit row, the archived
 * suffix, and everything the boundary disclosed.
 *
 * @since 0.1.0
 * @category models
 */
export type RewindResult = Rewind.Result

/**
 * How a fork chooses its workspace.
 *
 * The workspace name is derived from the child run id the fork mints, never
 * supplied; `workspaceRoot` only moves which lane that derived name lands in,
 * and defaults to `.flows/forks`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly workspaceRoot?: string | undefined
}

/**
 * How a rewind treats what it crosses.
 *
 * `detachedChildren` defaults to `"block"`: a live detached child refuses the
 * rewind rather than being cancelled behind the operator's back.
 *
 * @since 0.1.0
 * @category models
 */
export interface RewindOptions {
  readonly detachedChildren?: "block" | "cancel" | undefined
  readonly pageSize?: number | undefined
}

/**
 * Inspect, fork, and rewind over a journal.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly inspect: <S>(
    position: Position,
    projection: Projection<S>
  ) => Effect.Effect<S, TimeTravelError>
  readonly fork: (
    position: Position,
    options?: ForkOptions
  ) => Effect.Effect<ForkResult, TimeTravelError>
  readonly rewind: (
    position: Position,
    options?: RewindOptions
  ) => Effect.Effect<RewindResult, TimeTravelError>
}

/**
 * The injectable contracts the three operations read and write through.
 *
 * The store is the only time-travel-specific one; the rest are the journal,
 * run, cache, and jj services the engine already provides.
 */
type Requirements =
  | CacheStore.CacheStore
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore

/** The default lane a derived fork workspace lands in. */
const workspaceRoot = ".flows/forks"

/**
 * Mints the ownership identity every rewind and every recovery rides.
 *
 * Browser-safe on purpose: `Clock` and `Random` are services, so this never
 * reaches for `process.pid` or `node:crypto` the way an engine incarnation
 * does.
 *
 * `hostId` is per-incarnation rather than a constant `"time-travel"`, and
 * `pid` is 0 because there is no process behind this identity. Ownership
 * doctrine lets a liveness probe inspect a local PID only when two owners
 * share a `hostId` (`@smthrs/run-store`'s `Ownership.LivenessProbe`); a shared
 * constant would make two services on two machines look same-host and invite a
 * probe of PID 0. Two incarnations never claim the same host.
 */
const mintOwner: Effect.Effect<OwnerId> = Effect.gen(function*() {
  const nowMs = yield* Clock.currentTimeMillis
  const entropy = yield* Random.nextIntBetween(0, 0x7fffffff)
  const incarnation = `${nowMs}:${entropy}`
  return { hostId: `time-travel:${incarnation}`, pid: 0, nonce: `time-travel:${incarnation}` }
})

/**
 * How the service is composed.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /**
   * Whether the owner recorded on a run is still working, asked before startup
   * recovery takes an interrupted rewind's run over.
   *
   * Defaults to `Ownership.leaseLiveness()`: an owner is alive while its
   * persisted heartbeat is younger than `Ownership.heartbeatStaleAfter`. That
   * is the same default the engine's own run driver applies to the same rows,
   * and it is the weakest honest answer every host can give. A deployment that
   * can say more supplies its own check and refuses the takeover for longer.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
}

/**
 * Turns a liveness check into the evidence startup recovery hands `RunStore`.
 *
 * The kind is always `lease-expired`, and deliberately so. It is the only
 * host-neutral kind, and it is the one claim `RunStore.steal` re-verifies for
 * itself inside the same write (`heartbeat_at_ms < nowMs - staleAfter`), so a
 * supplied check can only ever REFUSE a takeover here, never widen one. The
 * two pid-shaped kinds would be a lie anyway: {@link mintOwner} gives every
 * incarnation its own `hostId`, so no two time-travel owners ever look
 * same-host, and `pid` is 0 because no process stands behind the identity.
 *
 * A `running` row that records no owner yields no evidence: there is nothing
 * to be alive or dead, and `steal` refuses such a snapshot regardless.
 */
const recoveryEvidence = (
  isAlive: Ownership.LivenessCheck
): NonNullable<Recovery.Options["livenessEvidence"]> =>
(_audit, row, claimant, nowMs) => {
  const expectedOwner = row.owner
  if (expectedOwner === null) return Effect.succeed(undefined)
  return Effect.map(
    isAlive(expectedOwner, { claimant, heartbeatAtMs: row.heartbeatAtMs, nowMs }),
    (alive) => alive ? undefined : { expectedOwner, checkedAtMs: nowMs, kind: "lease-expired" as const }
  )
}

/**
 * Builds the service over the ambient contracts under an explicit policy,
 * recovering first.
 *
 * The scope this is built in owns every fork workspace the service adds: a
 * fork lane is forgotten when the service is released, not when the call that
 * created it returns.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeWith = (
  options: Options = {}
): Effect.Effect<Service, TimeTravelError, Requirements | Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const services = yield* Effect.context<Requirements>()
    const owner = yield* mintOwner
    // The contribution door (`docs/specs/Concepts/Time Travel Service.md`
    // §"The open gap this leaves"):
    // handlers come from the composition that owns the effect boundary, and the
    // registry itself stays internal. Absent service means no handlers, which is
    // the pre-existing behaviour — every crossed irreversible effect blocks.
    const contributed = yield* Effect.serviceOption(CompensationHandlers)
    const registry = yield* EffectHandlerRegistry.make(
      Option.getOrElse(contributed, () => []).map((handler) => ({
        kind: handler.kind,
        tier: handler.tier,
        requiresIdempotencyKey: handler.requiresIdempotencyKey ?? false,
        residue: handler.residue,
        ...(handler.assess === undefined ? {} : { assess: handler.assess }),
        revert: handler.revert,
        rollback: handler.rollback
      }))
    )

    const provided = <A>(
      effect: Effect.Effect<
        A,
        TimeTravelError,
        Requirements | EffectHandlerRegistry.EffectHandlerRegistry | Scope.Scope
      >
    ): Effect.Effect<A, TimeTravelError> =>
      effect.pipe(
        Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
        Effect.provideService(Scope.Scope, scope),
        Effect.provideContext(services)
      )

    // Recovery is wiring, never an operation: a rewind interrupted by a crash is
    // finished or rolled back before this service accepts new work. An audit
    // whose run is still held elsewhere is declined rather than closed, so it
    // survives for the next build to pick up.
    const outcomes = yield* provided(Recovery.recover({
      owner,
      livenessEvidence: recoveryEvidence(options.isAlive ?? Ownership.leaseLiveness())
    }))
    // A `Failed` outcome closes an audit terminally. Discarding the array made
    // that invisible to the composition, so an operator learned about a rewind
    // recovery could not finish only by reading the audit table by hand.
    yield* Effect.forEach(
      outcomes.filter((outcome) => outcome._tag === "Failed"),
      (outcome) =>
        Effect.logError("time-travel: startup recovery closed an audit as failed").pipe(
          Effect.annotateLogs({
            auditId: outcome.auditId,
            code: outcome.error.code,
            reason: outcome.error.message
          })
        ),
      { discard: true }
    )

    /**
     * Folds the run's journal into its frame anchors before a verb reads them.
     *
     * BEST EFFORT on purpose. The anchor table is a cache of facts the journal
     * already holds, so a journal that cannot project — a composition wired
     * without the projection channel, a partial test double — must not turn a
     * fork or a rewind into a failure. What it does instead is leave the anchors
     * as they were, and the verbs already say what that costs: a fork with no
     * anchor at the frame reports a warning naming the workspace it could not
     * restore, and a rewind restores no pointer rather than a wrong one.
     */
    const refreshAnchors = (runId: string) =>
      SnapshotProjector.project(runId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("time-travel: could not refresh frame anchors", cause).pipe(
            Effect.annotateLogs({ runId })
          )
        )
      )

    return {
      inspect: <S>(position: Position, projection: Projection<S>) =>
        Effect.fn("TimeTravel.inspect")(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: position.runId,
            lineageId: position.frame.lineageId,
            seq: position.frame.seq
          })
          return yield* provided(
            Replay.rederive(position.frame, projection, { runId: position.runId })
          )
        })(),
      fork: (position, options) =>
        Effect.fn("TimeTravel.fork")(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: position.runId,
            lineageId: position.frame.lineageId,
            seq: position.frame.seq
          })
          return yield* provided(
            // The anchors a fork restores from are a projection of the engine's
            // own records, folded on demand: an ordinary engine run writes
            // journal rows, never this package's tables.
            refreshAnchors(position.runId).pipe(Effect.andThen(ForkOperation.fork({
              parentRunId: position.runId,
              frame: position.frame,
              workspaceRoot: options?.workspaceRoot ?? workspaceRoot
            })))
          )
        })(),
      rewind: (position, options) =>
        Effect.fn("TimeTravel.rewind")(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: position.runId,
            lineageId: position.frame.lineageId,
            seq: position.frame.seq
          })
          return yield* provided(
            // The validation phase runs before anything durable: a refused page
            // size or a frame that is not on this run's lineage leaves no claim,
            // no audit row, and no refreshed anchor behind.
            Schema.decodeUnknownEffect(Rewind.DetachedChildPolicy)(
              options?.detachedChildren ?? "block"
            ).pipe(
              // The policy is decoded before anything durable happens. An
              // untyped caller writing "blcok" used to select the DESTRUCTIVE
              // branch, because the assessment treated every value other than
              // the literal "block" as cancel.
              Effect.mapError(() =>
                error(
                  "invalid",
                  `detachedChildren must be "block" or "cancel", not ${JSON.stringify(options?.detachedChildren)}`
                )
              ),
              Effect.flatMap((detachedChildPolicy) =>
                Rewind.validate({
                  runId: position.runId,
                  frame: position.frame,
                  ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize })
                }).pipe(
                  Effect.flatMap((expectedTail) =>
                    refreshAnchors(position.runId).pipe(
                      Effect.andThen(Rewind.rewind({
                        runId: position.runId,
                        frame: position.frame,
                        owner,
                        detachedChildPolicy,
                        // The tail validation observed, re-checked under the
                        // claim: nothing else binds the refusal to the
                        // truncation it was asked about.
                        ...(expectedTail === undefined ? {} : { expectedTail }),
                        ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize })
                      }))
                    )
                  )
                )
              )
            )
          )
        })()
    }
  })

/**
 * Builds the service over the ambient contracts under the default policy,
 * recovering first.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, TimeTravelError, Requirements | Scope.Scope> = makeWith()

/**
 * The one injectable time-travel surface.
 *
 * The frame's lineage comes from `FlowEngine.Lineage`, the one place a journal
 * lineage id is minted. It is a versioned encoding rather than a path, so a
 * hand-spelled address names no record and `rewind` refuses it as `not_found`.
 *
 * ```ts
 * import { Engine, TimeTravel } from "@smthrs/flows"
 * import * as Effect from "effect/Effect"
 *
 * const program = Effect.gen(function*() {
 *   const timeTravel = yield* TimeTravel
 *   const lineageId = Engine.FlowEngine.Lineage.root("ledger-1")
 *   return yield* timeTravel.rewind({ runId: "ledger-1", frame: { lineageId, seq: 2 } })
 * })
 * ```
 *
 * @since 0.1.0
 * @category services
 */
export class TimeTravel extends Context.Service<TimeTravel, Service>()(
  "@smthrs/time-travel/TimeTravel"
) {
  /**
   * Wires the machinery over the injectable contracts and recovers on build.
   *
   * Carried as a static so the umbrella barrel can export the service key
   * itself — `yield* Flows.TimeTravel` — without losing the way to provide it.
   *
   * @since 0.1.0
   * @category layers
   */
  static readonly layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = Layer.effect(TimeTravel)(make)

  /**
   * The same wiring under an explicit policy. {@link Options.isAlive} is the
   * only knob, and it decides what startup recovery is allowed to conclude
   * about a run an interrupted rewind left `running`.
   *
   * @since 0.1.0
   * @category layers
   */
  static readonly layerWith = (
    options: Options
  ): Layer.Layer<TimeTravel, TimeTravelError, Requirements> => Layer.effect(TimeTravel)(makeWith(options))
}

/**
 * Wires the machinery over the injectable contracts and recovers on build.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = TimeTravel.layer

/**
 * Wires the machinery under an explicit policy and recovers on build.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (
  options: Options
): Layer.Layer<TimeTravel, TimeTravelError, Requirements> => TimeTravel.layerWith(options)
