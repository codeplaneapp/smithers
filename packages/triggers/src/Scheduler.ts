/**
 * Durable, Clock-driven trigger scheduling.
 *
 * @see docs/specs/Concepts/Flow Triggers.md
 *
 * @since 0.1.0
 */
import * as Control from "@smthrs/control/Control"
import type { PlanCard, Receipt } from "@smthrs/control/ControlSchema"
import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Option, Ref, Semaphore } from "effect"
import type * as Scope from "effect/Scope"
import * as CatchUp from "./CatchUp.ts"
import * as Cron from "./Cron.ts"
import { TriggerError } from "./TriggerError.ts"
import { type Claim, type Registered, TriggerStore } from "./TriggerStore.ts"

/**
 * Arguments used to launch one scheduled flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface StartInput {
  readonly flowId: string
  readonly input: unknown
  readonly idempotencyKey: string
}

/**
 * Runtime operations required by the scheduler.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunnerService {
  readonly start: (input: StartInput) => Effect.Effect<string, TriggerError>
  readonly isActive: (runId: string) => Effect.Effect<boolean, TriggerError>
  readonly cancel: (runId: string) => Effect.Effect<void, TriggerError>
}

/**
 * Injectable scheduled-run launcher.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, RunnerService>()("flows/triggers/Scheduler/Runner") {
  /**
   * Constructs a scheduled-run launcher.
   *
   * @category constructors
   * @since 0.1.0
   */
  static make(implementation: RunnerService): RunnerService {
    return Runner.of(implementation)
  }

  /**
   * Constructs a launcher that returns the idempotency key as a terminal run.
   *
   * @category constructors
   * @since 0.1.0
   */
  static makeNoop(overrides: Partial<RunnerService> = {}): RunnerService {
    return Runner.make({
      start: (input) => Effect.succeed(input.idempotencyKey),
      isActive: () => Effect.succeed(false),
      cancel: () => Effect.void,
      ...overrides
    })
  }

  /**
   * Provides the terminal no-op launcher.
   *
   * @category layers
   * @since 0.1.0
   */
  static layerNoop(
    overrides: Partial<RunnerService> = {}
  ): Layer.Layer<Runner> {
    return Layer.succeed(Runner)(Runner.makeNoop(overrides))
  }
}

/**
 * Constructs a scheduled-run launcher.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRunner = (implementation: RunnerService): RunnerService => Runner.make(implementation)

/**
 * Constructs a launcher that returns the idempotency key as a terminal run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoopRunner = (overrides: Partial<RunnerService> = {}): RunnerService => Runner.makeNoop(overrides)

/**
 * Provides the terminal no-op launcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoopRunner = (
  overrides: Partial<RunnerService> = {}
): Layer.Layer<Runner> => Runner.layerNoop(overrides)

const runnerError = (message: string, cause?: unknown): TriggerError =>
  new TriggerError({
    code: "store",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const duration = (
  input: Duration.Input,
  field: string
): Effect.Effect<Duration.Duration, TriggerError> =>
  Option.match(Duration.fromInput(input), {
    onNone: () =>
      Effect.fail(
        new TriggerError({
          code: "invalid_schedule",
          message: `${field} must be a valid Effect duration`
        })
      ),
    onSome: Effect.succeed
  })

const runIdFromReceipt = (receipt: Receipt): Effect.Effect<string, TriggerError> => {
  switch (receipt._tag) {
    case "Accepted":
    case "AlreadyApplied":
      return receipt.runId === undefined
        ? Effect.fail(runnerError(`Control ${receipt._tag} receipt did not include a run id`))
        : Effect.succeed(receipt.runId)
    case "Terminal":
      return Effect.succeed(receipt.runId)
    case "Parked":
      return Effect.fail(
        runnerError(`Control plan ${receipt.planId} is parked awaiting approval`)
      )
    case "Conflict":
      return Effect.fail(runnerError(`Control rejected the scheduled run: ${receipt.message}`))
  }
}

const runApprovedPlan = (
  control: Control.Service,
  plan: PlanCard,
  key: string
): Effect.Effect<string, TriggerError> =>
  control.run({
    _tag: "Plan",
    planId: plan.planId,
    digest: plan.digest,
    envelope: plan.envelope,
    idempotencyKey: key
  }).pipe(
    Effect.mapError((error) => runnerError("Control could not launch the scheduled run", error)),
    Effect.flatMap((receipt) =>
      receipt._tag === "Parked"
        ? Effect.sleep("1 second").pipe(
          Effect.andThen(Effect.suspend(() => runApprovedPlan(control, plan, key)))
        )
        : runIdFromReceipt(receipt)
    )
  )

/**
 * Runner layer backed by the authoritative Control plan/run/list/cancel API.
 *
 * A parked plan waits for approval and retries the same idempotent run request;
 * this adapter never approves it or reconstructs an execution envelope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControlRunner: Layer.Layer<Runner, never, Control.Control> = Layer.effect(
  Runner,
  Effect.gen(function*() {
    const control = yield* Control.Control
    return makeRunner({
      start: (input) =>
        control.plan(input).pipe(
          Effect.flatMap((plan) => runApprovedPlan(control, plan, input.idempotencyKey)),
          Effect.mapError((error) =>
            error instanceof TriggerError
              ? error
              : runnerError("Control could not launch the scheduled run", error)
          )
        ),
      isActive: (runId) =>
        control.list({ _tag: "runs" }).pipe(
          Effect.map((response) => {
            if (response._tag !== "runs") return false
            const run = response.items.find((candidate) => candidate.runId === runId)
            return run !== undefined &&
              (run.status === "running" || run.status === "parked" || run.status === "waiting-approval")
          }),
          Effect.mapError((error) => runnerError(`Control could not inspect run ${runId}`, error))
        ),
      cancel: (runId) =>
        control.cancel({
          runId,
          idempotencyKey: `trigger-cancel:${runId}`
        }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => runnerError(`Control could not cancel run ${runId}`, error))
        )
    })
  })
)

/**
 * Scheduler timing configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly pollInterval?: Duration.Input | undefined
  readonly runPollInterval?: Duration.Input | undefined
}

/**
 * Scheduler operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly runOnce: Effect.Effect<void, TriggerError>
}

/**
 * The live trigger scheduler.
 *
 * @category services
 * @since 0.1.0
 */
export class Scheduler extends Context.Service<Scheduler, Service>()("flows/triggers/Scheduler") {}

interface Active {
  readonly occurrence: number
  readonly runId?: string | undefined
  readonly fiber?: Fiber.Fiber<void> | undefined
}

const idempotencyKey = (triggerId: string, occurrence: number): string =>
  `${triggerId}:${new Date(occurrence).toISOString()}`

/**
 * Confines one trigger's failure to that trigger.
 *
 * A tick walks the due triggers in id order, so an aborting trigger used to
 * take every trigger after it alphabetically down with it, and the supervisor
 * above discarded the error unread. The cause is logged where the trigger it
 * belongs to is still known. Interruption is re-raised: it is the scope
 * closing, not a trigger failing.
 */
const isolate = (
  triggerId: string,
  work: string,
  effect: Effect.Effect<void, TriggerError>
): Effect.Effect<void, TriggerError> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.annotateLogs(Effect.logWarning(`A trigger ${work} failed`, cause), { triggerId }))

/**
 * Constructs a scheduler service in the current Scope.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options = {}
): Effect.Effect<Service, TriggerError, Runner | Scope.Scope | TriggerStore> =>
  Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const runner = yield* Runner
    const store = yield* TriggerStore
    const active = yield* Ref.make<ReadonlyMap<string, Active>>(new Map())
    const observedAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    const semaphore = yield* Semaphore.make(1)
    const runPollInterval = yield* duration(options.runPollInterval ?? "1 second", "runPollInterval")

    const removeActive = (triggerId: string, occurrence: number): Effect.Effect<void> =>
      Ref.update(active, (current) => {
        const entry = current.get(triggerId)
        if (entry?.occurrence !== occurrence) return current
        const next = new Map(current)
        next.delete(triggerId)
        return next
      })

    const resolveActive = (
      trigger: Registered
    ): Effect.Effect<Active | undefined, TriggerError> =>
      Effect.gen(function*() {
        const local = (yield* Ref.get(active)).get(trigger.id)
        if (local !== undefined) {
          if (local.fiber !== undefined && local.fiber.pollUnsafe() === undefined) {
            return local
          }
          if (
            local.fiber === undefined &&
            local.runId !== undefined &&
            (yield* runner.isActive(local.runId))
          ) return local
          if (local.runId !== undefined) yield* store.clearActive(trigger.id, local.runId)
          yield* removeActive(trigger.id, local.occurrence)
        }
        const stored = yield* store.activeRun(trigger.id)
        if (Option.isNone(stored)) return undefined
        const running = stored.value.startsWith("trigger-reservation:")
          ? true
          : yield* runner.isActive(stored.value)
        if (!running) {
          yield* store.clearActive(trigger.id, stored.value)
          return undefined
        }
        const recovered: Active = {
          occurrence: trigger.lastFiredAt ?? Number.NEGATIVE_INFINITY,
          runId: stored.value
        }
        yield* Ref.update(active, (current) => new Map(current).set(trigger.id, recovered))
        return recovered
      })

    const recordFailed = (
      trigger: Registered,
      occurrence: number,
      error: TriggerError,
      runId?: string | undefined
    ): Effect.Effect<void, TriggerError> =>
      store.recordResult({
        triggerId: trigger.id,
        occurrence,
        outcome: "failed",
        error: error.message,
        ...(runId === undefined ? {} : { runId })
      })

    const launch = (
      trigger: Registered,
      occurrence: number
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        let runId: string | undefined
        const lifecycle = Effect.gen(function*() {
          runId = yield* runner.start({
            flowId: trigger.flowId,
            input: trigger.input,
            idempotencyKey: idempotencyKey(trigger.id, occurrence)
          })
          yield* Ref.update(active, (current) => {
            const entry = current.get(trigger.id)
            if (entry?.occurrence !== occurrence) return current
            return new Map(current).set(trigger.id, { ...entry, runId })
          })
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence,
            outcome: "launched",
            runId
          })
          while (yield* runner.isActive(runId)) {
            yield* Effect.sleep(runPollInterval)
          }
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence,
            outcome: "completed",
            runId
          })
        }).pipe(
          Effect.catch((error) => recordFailed(trigger, occurrence, error, runId).pipe(Effect.ignore)),
          Effect.onInterrupt(() => runId === undefined ? Effect.void : runner.cancel(runId).pipe(Effect.ignore)),
          Effect.ensuring(removeActive(trigger.id, occurrence))
        )
        const fiber = yield* Effect.forkIn(
          Effect.scoped(lifecycle),
          parentScope,
          { startImmediately: true }
        )
        yield* Ref.update(active, (current) => {
          const entry = current.get(trigger.id)
          if (entry?.occurrence === occurrence) {
            return new Map(current).set(trigger.id, { ...entry, fiber })
          }
          if (fiber.pollUnsafe() !== undefined) return current
          return new Map(current).set(trigger.id, { occurrence, fiber })
        })
      })

    const cancelActive = (
      trigger: Registered,
      prior: Active
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        if (prior.fiber !== undefined) yield* Fiber.interrupt(prior.fiber)
        if (prior.runId !== undefined) yield* runner.cancel(prior.runId)
        if (Number.isFinite(prior.occurrence)) {
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence: prior.occurrence,
            outcome: "superseded",
            ...(prior.runId === undefined ? {} : { runId: prior.runId })
          })
        }
        yield* removeActive(trigger.id, prior.occurrence)
      })

    const dispatchClaimed = (
      trigger: Registered,
      occurrence: number,
      claim: Exclude<Claim, { readonly claimed: false }>
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        switch (claim.action) {
          case "fire":
            yield* Ref.update(
              active,
              (current) =>
                new Map(current).set(trigger.id, {
                  occurrence,
                  runId: claim.reservationId
                })
            )
            yield* launch(trigger, occurrence)
            return
          case "skip":
            yield* store.recordResult({
              triggerId: trigger.id,
              occurrence,
              outcome: "skipped"
            })
            return
          case "buffer":
            yield* store.recordResult({
              triggerId: trigger.id,
              occurrence,
              outcome: "buffered"
            })
            return
          case "supersede":
            if (claim.activeRunId !== undefined) {
              const local = (yield* Ref.get(active)).get(trigger.id)
              yield* cancelActive(
                trigger,
                local?.runId === claim.activeRunId
                  ? local
                  : {
                    occurrence: trigger.lastFiredAt ?? Number.NEGATIVE_INFINITY,
                    runId: claim.activeRunId
                  }
              )
            }
            yield* Ref.update(
              active,
              (current) =>
                new Map(current).set(trigger.id, {
                  occurrence,
                  runId: claim.reservationId
                })
            )
            yield* launch(trigger, occurrence)
            return
        }
      })

    const claimAndDispatch = (
      trigger: Registered,
      occurrence: number
    ): Effect.Effect<void, TriggerError> =>
      store.claimFire({ triggerId: trigger.id, occurrence, overlap: trigger.overlap }).pipe(
        Effect.flatMap((claim) => claim.claimed ? dispatchClaimed(trigger, occurrence, claim) : Effect.void)
      )

    const dueOccurrences = (
      trigger: Registered,
      now: number
    ): Effect.Effect<ReadonlyArray<number>, TriggerError> =>
      Effect.gen(function*() {
        const cron = yield* Cron.parse(trigger.cron, trigger.timezone)
        const observed = (yield* Ref.get(observedAt)).get(trigger.id)
        yield* Ref.update(observedAt, (current) => new Map(current).set(trigger.id, now))
        if (observed === undefined) {
          if (trigger.lastFiredAt === undefined) {
            return [(yield* Cron.previousAtOrBefore(cron, new Date(now))).getTime()]
          }
          return (yield* CatchUp.occurrences(
            trigger.catchUp,
            trigger.maxCatchUp,
            new Date(trigger.lastFiredAt),
            new Date(now),
            cron
          )).map((occurrence) => occurrence.getTime())
        }

        const current = yield* Cron.previousAtOrBefore(cron, new Date(now))
        if (current.getTime() <= observed) return []
        const backlog = yield* CatchUp.occurrences(
          trigger.catchUp,
          trigger.maxCatchUp,
          new Date(observed),
          new Date(current.getTime() - 1),
          cron
        )
        return [...backlog, current].map((occurrence) => occurrence.getTime())
      })

    const processTrigger = (
      trigger: Registered,
      now: number
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        const running = yield* resolveActive(trigger)
        if (running === undefined) {
          const pending = yield* store.takePending(trigger.id)
          if (Option.isSome(pending)) {
            const claim = yield* store.claimFire({
              triggerId: trigger.id,
              occurrence: pending.value,
              overlap: trigger.overlap,
              resumeBuffered: true
            })
            if (claim.claimed) yield* dispatchClaimed(trigger, pending.value, claim)
          }
        }
        const occurrences = yield* dueOccurrences(trigger, now)
        yield* Effect.forEach(
          occurrences,
          (occurrence) =>
            isolate(trigger.id, `dispatch of occurrence ${occurrence}`, claimAndDispatch(trigger, occurrence)),
          { discard: true }
        )
      })

    const runOnce = semaphore.withPermits(1)(
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const triggers = yield* store.due(now)
        yield* Effect.forEach(
          triggers,
          (trigger) => isolate(trigger.id, "tick", processTrigger(trigger, now)),
          { discard: true }
        )
      })
    )

    return Scheduler.of({ runOnce })
  })

/**
 * Constructs a scheduler that performs no work.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => Scheduler.of({ runOnce: Effect.void })

/**
 * Scoped scheduler layer. Its supervisor sleeps only through the Effect Clock,
 * so scope closure interrupts both the loop and all child run fibers.
 *
 * The loop recovers from the whole cause rather than the typed error alone. A
 * defect raised anywhere under a tick, which `Effect.catch` by contract leaves
 * alone, would otherwise kill this fiber and stop every trigger in the process
 * with nothing written down.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<Scheduler, TriggerError, Runner | TriggerStore> =>
  Layer.effect(
    Scheduler,
    Effect.gen(function*() {
      const scheduler = yield* make(options)
      const pollInterval = yield* duration(options.pollInterval ?? "1 minute", "pollInterval")
      yield* Effect.forkScoped(
        Effect.forever(
          scheduler.runOnce.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("A trigger scheduler tick failed", cause)
            ),
            Effect.andThen(Effect.sleep(pollInterval))
          )
        )
      )
      return scheduler
    })
  )

/**
 * Provides an inert scheduler without allocating a supervisor fiber.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Scheduler> = Layer.succeed(Scheduler)(makeNoop())
