/**
 * Durable, Clock-driven trigger scheduling.
 *
 * @see packages/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import * as Control from "@smthrs/control/Control"
import type { PlanCard, Receipt, RunStatus } from "@smthrs/control/ControlSchema"
import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Option, Ref, Semaphore } from "effect"
import type * as Scope from "effect/Scope"
import * as CatchUp from "./CatchUp.ts"
import * as Cron from "./Cron.ts"
import { TriggerError } from "./TriggerError.ts"
import { type Claim, isReservation, type Registered, TriggerStore } from "./TriggerStore.ts"

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
 * Constructed with {@link makeRunner}, {@link makeNoopRunner}, or
 * {@link layerNoopRunner}; the tag itself carries no constructors, so there is
 * one spelling of each and the module's own `make`/`makeNoop` can only mean
 * the scheduler.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, RunnerService>()("flows/triggers/Scheduler/Runner") {}

/**
 * Constructs a scheduled-run launcher.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRunner = (implementation: RunnerService): RunnerService => Runner.of(implementation)

/**
 * Constructs a launcher that returns the idempotency key as a terminal run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoopRunner = (overrides: Partial<RunnerService> = {}): RunnerService =>
  makeRunner({
    start: (input) => Effect.succeed(input.idempotencyKey),
    isActive: () => Effect.succeed(false),
    cancel: () => Effect.void,
    ...overrides
  })

/**
 * Provides the terminal no-op launcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoopRunner = (
  overrides: Partial<RunnerService> = {}
): Layer.Layer<Runner> => Layer.succeed(Runner)(makeNoopRunner(overrides))

const runnerError = (message: string, cause?: unknown): TriggerError =>
  new TriggerError({
    code: "runner",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const invalidOption = (field: string, requirement: string): TriggerError =>
  new TriggerError({
    code: "invalid_options",
    message: `${field} must be ${requirement}`,
    path: field
  })

const duration = (
  input: Duration.Input,
  field: string
): Effect.Effect<Duration.Duration, TriggerError> =>
  Option.match(Duration.fromInput(input), {
    onNone: () => Effect.fail(invalidOption(field, "a valid Effect duration")),
    onSome: (value) =>
      // Zero polls a CPU-tight loop and an infinite interval never completes,
      // and `Duration.fromInput` accepts both.
      Duration.isFinite(value) && Duration.toMillis(value) > 0
        ? Effect.succeed(value)
        : Effect.fail(invalidOption(field, "a finite positive duration"))
  })

const runIdFromReceipt = (
  receipt: Exclude<Receipt, { readonly _tag: "Parked" }>
): Effect.Effect<string, TriggerError> => {
  switch (receipt._tag) {
    case "Accepted":
    case "AlreadyApplied":
      return receipt.runId === undefined
        ? Effect.fail(runnerError(`Control ${receipt._tag} receipt did not include a run id`))
        : Effect.succeed(receipt.runId)
    case "Terminal":
      return Effect.succeed(receipt.runId)
    case "Conflict":
      return Effect.fail(runnerError(`Control rejected the scheduled run: ${receipt.message}`))
  }
}

/**
 * How many times a parked plan is re-offered before the launch is abandoned.
 *
 * The delay doubles from one second, so the eighth attempt lands a little over
 * two minutes in. A plan nobody approves used to be re-offered once a second
 * for the life of the scope while the launch reservation behind it expired.
 *
 * @category constants
 * @since 0.1.0
 */
export const parkedAttempts = 8

const runApprovedPlan = (
  control: Control.Service,
  plan: PlanCard,
  key: string,
  attempt: number
): Effect.Effect<string, TriggerError> =>
  control.run({
    _tag: "Plan",
    planId: plan.planId,
    digest: plan.digest,
    envelope: plan.envelope,
    idempotencyKey: key
  }).pipe(
    Effect.mapError((error) => runnerError("Control could not launch the scheduled run", error)),
    Effect.flatMap((receipt) => {
      if (receipt._tag !== "Parked") return runIdFromReceipt(receipt)
      if (attempt >= parkedAttempts) {
        return Effect.fail(
          runnerError(
            `Control plan ${plan.planId} is still parked awaiting approval after ${attempt} attempts`
          )
        )
      }
      return Effect.logInfo(`A scheduled plan is parked awaiting approval, attempt ${attempt}`).pipe(
        Effect.andThen(Effect.sleep(Duration.millis(1000 * 2 ** (attempt - 1)))),
        Effect.andThen(Effect.suspend(() => runApprovedPlan(control, plan, key, attempt + 1)))
      )
    })
  )

/**
 * The statuses that mean a run has stopped for good.
 *
 * Liveness is stated as the complement of this set rather than as a list of
 * live statuses, so a status Control adds later is treated as live until this
 * package says otherwise. Reading it the other way round is what dropped
 * `accepted`, the status every run holds between its claim and its first
 * executed step (`packages/control/src/ControlLive.ts`).
 */
const settled: ReadonlySet<RunStatus> = new Set<RunStatus>(["cancelled", "completed", "failed"])

/**
 * Runner layer backed by the authoritative Control plan/run/list/cancel API.
 *
 * A parked plan waits for approval and retries the same idempotent run request
 * a bounded number of times; this adapter never approves it or reconstructs an
 * execution envelope.
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
          Effect.flatMap((plan) => runApprovedPlan(control, plan, input.idempotencyKey, 1)),
          Effect.mapError((error) =>
            error instanceof TriggerError
              ? error
              : runnerError("Control could not launch the scheduled run", error)
          )
        ),
      isActive: (runId) =>
        control.list({ _tag: "runs", filters: { runId }, limit: 1 }).pipe(
          Effect.map((response) => {
            if (response._tag !== "runs") return false
            const run = response.items.find((candidate) => candidate.runId === runId)
            return run !== undefined && !settled.has(run.status)
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

/**
 * What this process knows about the run one trigger currently owns: which
 * occurrence claimed it, the reservation or run id the store holds for it, and
 * the monitor fiber when this process is the one watching it.
 *
 * `runId` is always known. A claim that hands out work names the reservation it
 * wrote, and a recovered entry is read back from the store, so an entry with
 * nothing to release cannot be constructed.
 */
interface Active {
  readonly occurrence: number
  readonly runId: string
  readonly fiber?: Fiber.Fiber<void> | undefined
}

interface Due {
  readonly occurrences: ReadonlyArray<number>
  readonly watermark: number
}

const idempotencyKey = (triggerId: string, occurrence: number): string =>
  `${triggerId}:${new Date(occurrence).toISOString()}`

/**
 * Runs one trigger's work and reports whether it finished.
 *
 * A tick walks the due triggers in id order, so an aborting trigger used to
 * take every trigger after it alphabetically down with it, and the supervisor
 * above discarded the error unread. The cause is logged where the trigger it
 * belongs to is still known. Interruption is re-raised: it is the scope
 * closing, not a trigger failing.
 */
const attempted = (
  triggerId: string,
  work: string,
  effect: Effect.Effect<void, TriggerError>
): Effect.Effect<boolean, TriggerError> =>
  Effect.catchCause(Effect.as(effect, true), (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.as(
        Effect.annotateLogs(Effect.logWarning(`A trigger ${work} failed`, cause), { triggerId }),
        false
      ))

const isolate = (
  triggerId: string,
  work: string,
  effect: Effect.Effect<void, TriggerError>
): Effect.Effect<void, TriggerError> => Effect.asVoid(attempted(triggerId, work, effect))

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

    // The watermark only moves forward, and only past occurrences this process
    // finished dispatching. Advancing it before the work is what silently lost
    // an occurrence whenever a claim or a dispatch failed.
    const observe = (triggerId: string, occurrence: number): Effect.Effect<void> =>
      Ref.update(observedAt, (current) => {
        const existing = current.get(triggerId)
        if (existing !== undefined && existing >= occurrence) return current
        return new Map(current).set(triggerId, occurrence)
      })

    // Every write to an entry is fenced on the occurrence that claimed it, so
    // one guard states the rule once: a launch that has been superseded, or
    // whose run already settled, no longer owns the entry and must not write to
    // it. Spelling the fence out at each site is how the three copies of it
    // drifted apart.
    const updateActive = (
      triggerId: string,
      occurrence: number,
      change: (entry: Active) => Active | undefined
    ): Effect.Effect<void> =>
      Ref.update(active, (current) => {
        const entry = current.get(triggerId)
        if (entry?.occurrence !== occurrence) return current
        const next = new Map(current)
        const updated = change(entry)
        if (updated === undefined) next.delete(triggerId)
        else next.set(triggerId, updated)
        return next
      })

    const removeActive = (triggerId: string, occurrence: number): Effect.Effect<void> =>
      updateActive(triggerId, occurrence, () => undefined)

    // A reservation is not a run: the Runner has never heard of it, and asking
    // answers "not active" for a launch that is still in flight. Its lease is
    // the only thing entitled to release it, in either branch.
    const stillRunning = (runId: string): Effect.Effect<boolean, TriggerError> =>
      isReservation(runId) ? Effect.succeed(true) : runner.isActive(runId)

    const resolveActive = (
      trigger: Registered
    ): Effect.Effect<Active | undefined, TriggerError> =>
      Effect.gen(function*() {
        const local = (yield* Ref.get(active)).get(trigger.id)
        if (local !== undefined) {
          // A monitored entry is removed by the monitor's own finalizer when
          // its lifecycle ends, however it ends, so a fiber still in the map is
          // a live monitor and there is nothing left to ask. An entry without
          // one was recovered from the store, and only the runtime can say
          // whether that run is still going.
          if (local.fiber !== undefined || (yield* stillRunning(local.runId))) return local
          yield* store.clearActive(trigger.id, local.runId)
          yield* removeActive(trigger.id, local.occurrence)
        }
        const stored = yield* store.activeRun(trigger.id)
        if (Option.isNone(stored)) return undefined
        if (!(yield* stillRunning(stored.value))) {
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
          const started = runId
          yield* updateActive(trigger.id, occurrence, (entry) => ({ ...entry, runId: started }))
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
          // Interrupting this fiber detaches the monitor; it never cancels the
          // run. The run is durable and outlives this process, so a deploy or
          // any other scope closure must leave it alone: the next incarnation
          // re-attaches through `resolveActive`. Cancellation is a deliberate
          // act and belongs to `cancelActive` alone.
          Effect.ensuring(removeActive(trigger.id, occurrence))
        )
        const fiber = yield* Effect.forkIn(
          Effect.scoped(lifecycle),
          parentScope,
          { startImmediately: true }
        )
        // The monitor is recorded against the entry this occurrence claimed.
        // `startImmediately` means a run that settled before its first poll has
        // already removed that entry by the time this runs, and a fiber with
        // nothing left to interrupt is not worth putting back.
        yield* updateActive(trigger.id, occurrence, (entry) => ({ ...entry, fiber }))
      })

    // Only a claim that named the run it is superseding gets here, so the run
    // id is known. The monitor, on the other hand, may not exist: the run can
    // belong to a scheduler this one only knows through the store. Cancelling
    // is a deliberate act and happens here alone; a reservation has no run for
    // the runtime to cancel, and an occurrence this process never saw has none
    // of its own to record the supersession against.
    const cancelActive = (
      trigger: Registered,
      prior: Active & { readonly runId: string }
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        if (prior.fiber !== undefined) yield* Fiber.interrupt(prior.fiber)
        if (!isReservation(prior.runId)) yield* runner.cancel(prior.runId)
        if (Number.isFinite(prior.occurrence)) {
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence: prior.occurrence,
            outcome: "superseded",
            runId: prior.runId
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
          case "supersede": {
            const superseded = claim.activeRunId
            if (superseded !== undefined) {
              const local = (yield* Ref.get(active)).get(trigger.id)
              yield* cancelActive(
                trigger,
                local !== undefined && local.runId === superseded
                  ? { ...local, runId: superseded }
                  : {
                    occurrence: trigger.lastFiredAt ?? Number.NEGATIVE_INFINITY,
                    runId: superseded
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
        }
      })

    const claimOnce = (
      trigger: Registered,
      occurrence: number,
      resumeBuffered: boolean
    ): Effect.Effect<void, TriggerError> =>
      store.claimFire({
        triggerId: trigger.id,
        occurrence,
        expectedRevision: trigger.revision,
        ...(resumeBuffered ? { resumeBuffered: true } : {})
      }).pipe(
        Effect.flatMap((claim) => claim.claimed ? dispatchClaimed(trigger, occurrence, claim) : Effect.void)
      )

    // The claim is fenced on the revision the occurrence was computed from, so
    // an edit that landed mid-tick refuses the claim instead of firing a
    // declaration this tick never read. One refresh and one retry is enough:
    // the next tick re-reads the declaration anyway.
    const claimAndDispatch = (
      trigger: Registered,
      occurrence: number,
      resumeBuffered = false
    ): Effect.Effect<void, TriggerError> =>
      claimOnce(trigger, occurrence, resumeBuffered).pipe(
        Effect.catch((error) =>
          error.code !== "revision_mismatch"
            ? Effect.fail(error)
            : store.get(trigger.id).pipe(
              Effect.flatMap((refreshed) =>
                Option.isNone(refreshed) || refreshed.value.revision === trigger.revision
                  ? Effect.fail(error)
                  : claimOnce(refreshed.value, occurrence, resumeBuffered)
              )
            )
        )
      )

    // A buffered occurrence is taken out of the row before it can be claimed,
    // so a failure between the two would drop it with nothing left to
    // re-derive it from. Re-arming restores the buffer the take emptied.
    const resumePending = (trigger: Registered): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        const pending = yield* store.takePending(trigger.id)
        if (Option.isNone(pending)) return
        yield* claimAndDispatch(trigger, pending.value, true).pipe(
          Effect.onError(() =>
            store.setPending({ triggerId: trigger.id, occurrence: pending.value }).pipe(Effect.ignore)
          )
        )
      })

    // A bound the declaration cannot honour is a statement about how much
    // history to replay, not a reason to stop scheduling: the backlog beyond
    // the bound is abandoned, loudly, and the current occurrence still fires.
    const withinBound = (
      triggerId: string,
      owed: Effect.Effect<ReadonlyArray<Date>, TriggerError>
    ): Effect.Effect<ReadonlyArray<Date>, TriggerError> =>
      Effect.catch(owed, (error) =>
        error.code === "catch_up_bound_exceeded"
          ? Effect.as(
            Effect.annotateLogs(
              Effect.logWarning("A trigger abandoned catch-up work beyond its bound", error),
              { triggerId }
            ),
            [] as ReadonlyArray<Date>
          )
          : Effect.fail(error))

    const dueOccurrences = (
      trigger: Registered,
      now: number
    ): Effect.Effect<Due, TriggerError> =>
      Effect.gen(function*() {
        const cron = yield* Cron.parse(trigger.cron, trigger.timezone)
        const observed = (yield* Ref.get(observedAt)).get(trigger.id)
        const current = (yield* Cron.previousAtOrBefore(cron, new Date(now))).getTime()
        if (observed === undefined) {
          // First sight of this trigger in this process. A trigger that has
          // never fired starts from here rather than from whatever occurrence
          // last passed: registering a weekly trigger on a Sunday evening owes
          // nothing for the Monday six days gone, which is what `catchUp` says.
          if (trigger.lastFiredAt === undefined) return { occurrences: [], watermark: current }
          const owed = yield* withinBound(
            trigger.id,
            CatchUp.occurrences(
              trigger.catchUp,
              trigger.maxCatchUp,
              new Date(trigger.lastFiredAt),
              new Date(now),
              cron
            )
          )
          return { occurrences: owed.map((occurrence) => occurrence.getTime()), watermark: current }
        }
        if (current <= observed) return { occurrences: [], watermark: observed }
        const backlog = yield* withinBound(
          trigger.id,
          CatchUp.occurrences(
            trigger.catchUp,
            trigger.maxCatchUp,
            new Date(observed),
            new Date(current - 1),
            cron
          )
        )
        return {
          occurrences: [...backlog.map((occurrence) => occurrence.getTime()), current],
          watermark: current
        }
      })

    const processTrigger = (
      trigger: Registered,
      now: number
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        const running = yield* resolveActive(trigger)
        if (running === undefined) yield* resumePending(trigger)
        const due = yield* dueOccurrences(trigger, now)
        let dispatched: number | undefined
        let interrupted = false
        for (const occurrence of due.occurrences) {
          const settledHere = yield* attempted(
            trigger.id,
            `dispatch of occurrence ${occurrence}`,
            claimAndDispatch(trigger, occurrence)
          )
          if (settledHere && !interrupted) dispatched = occurrence
          if (!settledHere) interrupted = true
        }
        if (!interrupted) return yield* observe(trigger.id, due.watermark)
        if (dispatched !== undefined) yield* observe(trigger.id, dispatched)
      })

    const runOnce = semaphore.withPermits(1)(
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const triggers = yield* store.listEnabled()
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
 * so scope closure interrupts the poll loop and detaches every run monitor.
 * Detaching is all it does: the runs themselves are durable and keep going,
 * and the next incarnation re-attaches to them from the store.
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
