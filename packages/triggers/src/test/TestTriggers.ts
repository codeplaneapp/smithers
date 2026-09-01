/** @since 0.1.0 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Overlap from "../Overlap.ts"
import { TriggerError } from "../TriggerError.ts"
import {
  type Claim,
  type ClaimFire,
  isReservation,
  type Outcome,
  type Registered,
  reservationId,
  reservationLeaseMs,
  type Service,
  TriggerStore
} from "../TriggerStore.ts"

interface State {
  readonly triggers: ReadonlyMap<string, Registered>
  readonly fires: ReadonlyMap<string, Outcome | null>
  readonly pending: ReadonlyMap<string, number>
  readonly active: ReadonlyMap<string, string>
  readonly activeClaimedAt: ReadonlyMap<string, number>
}

const key = (triggerId: string, occurrence: number) => `${triggerId}:${occurrence}`
const unknown = (triggerId: string) =>
  new TriggerError({ code: "unknown_trigger", message: `unknown trigger ${triggerId}` })

/**
 * The refusals a claim owes before it applies any policy, in the order the SQL
 * store applies them. Returning the same codes is what makes this layer a
 * usable stand-in rather than a second, kinder set of rules. A missing row is
 * refused by the caller, which is where the narrowing belongs.
 */
const refuseClaim = (
  trigger: Registered,
  fire: ClaimFire
): TriggerError | undefined => {
  if (trigger.revision !== fire.expectedRevision) {
    return new TriggerError({
      code: "revision_mismatch",
      message: `trigger ${fire.triggerId} is at revision ${trigger.revision}, not the claimed ${fire.expectedRevision}`
    })
  }
  if (!trigger.enabled) {
    return new TriggerError({ code: "trigger_disabled", message: `trigger ${fire.triggerId} is disabled` })
  }
  return undefined
}

const advanced = (trigger: Registered, occurrence: number): Registered => ({
  ...trigger,
  lastFiredAt: Math.max(trigger.lastFiredAt ?? occurrence, occurrence)
})

type ClaimDecision =
  | { readonly _tag: "Failure"; readonly error: TriggerError }
  | { readonly _tag: "Success"; readonly claim: Claim; readonly state: State }

const applyClaim = (
  trigger: Registered,
  fire: ClaimFire,
  current: State,
  claimedAt: number
): ClaimDecision => {
  const refusal = refuseClaim(trigger, fire)
  if (refusal !== undefined) return { _tag: "Failure", error: refusal }

  const fireKey = key(fire.triggerId, fire.occurrence)
  const fireExists = current.fires.has(fireKey)
  const existingOutcome = current.fires.get(fireKey)
  let activeRunId = current.active.get(fire.triggerId)
  const reservation = reservationId(fire.triggerId, fire.occurrence)
  const claimTime = current.activeClaimedAt.get(fire.triggerId)
  const expiredReservation = activeRunId !== undefined && isReservation(activeRunId) &&
      (claimTime === undefined || claimTime <= claimedAt - reservationLeaseMs)
    ? activeRunId
    : undefined
  if (fireExists) {
    const resumableBuffer = fire.resumeBuffered === true && existingOutcome === "buffered"
    const resumableReservation = existingOutcome === null &&
      (activeRunId === undefined || (activeRunId === reservation && expiredReservation !== undefined))
    if (!resumableBuffer && !resumableReservation) {
      return { _tag: "Success", claim: { claimed: false }, state: current }
    }
  }

  const active = new Map(current.active)
  const activeClaimedAt = new Map(current.activeClaimedAt)
  if (expiredReservation !== undefined) {
    active.delete(fire.triggerId)
    activeClaimedAt.delete(fire.triggerId)
    activeRunId = undefined
  }
  const overlapState: Overlap.State = {
    running: activeRunId !== undefined,
    pending: current.pending.get(fire.triggerId),
    due: fire.occurrence
  }
  const action = Overlap.decide(trigger.overlap, overlapState)
  const fires = new Map(current.fires)
  if (!fireExists) fires.set(fireKey, null)
  const pending = new Map(current.pending)
  const triggers = new Map(current.triggers).set(fire.triggerId, advanced(trigger, fire.occurrence))
  if (action === "skip" || action === "buffer") {
    fires.set(fireKey, action === "skip" ? "skipped" : "buffered")
    if (action === "buffer") pending.set(fire.triggerId, Overlap.pendingAfter(overlapState))
    return {
      _tag: "Success",
      claim: { claimed: true, action },
      state: { ...current, fires, active, activeClaimedAt, pending, triggers }
    }
  }
  active.set(fire.triggerId, reservation)
  activeClaimedAt.set(fire.triggerId, claimedAt)
  return {
    _tag: "Success",
    claim: {
      claimed: true,
      action,
      reservationId: reservation,
      ...(activeRunId === undefined ? {} : { activeRunId })
    },
    state: { ...current, fires, active, activeClaimedAt, pending, triggers }
  }
}

/**
 * Provides an in-memory {@link TriggerStore} for tests: real claim and
 * overlap semantics, no database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<TriggerStore> = Layer.effect(TriggerStore)(Effect.gen(function*() {
  const state = yield* Ref.make<State>({
    triggers: new Map(),
    fires: new Map(),
    pending: new Map(),
    active: new Map(),
    activeClaimedAt: new Map()
  })
  const get: Service["get"] = (triggerId) =>
    Ref.get(state).pipe(Effect.map((current) => {
      const trigger = current.triggers.get(triggerId)
      return trigger === undefined ? Option.none() : Option.some(trigger)
    }))
  const requireTrigger = <A>(
    triggerId: string,
    modify: (trigger: Registered, current: State) => readonly [A, State]
  ): Effect.Effect<A, TriggerError> =>
    Ref.modify(state, (current): readonly [Effect.Effect<A, TriggerError>, State] => {
      const trigger = current.triggers.get(triggerId)
      if (trigger === undefined) return [Effect.fail(unknown(triggerId)), current]
      const [value, next] = modify(trigger, current)
      return [Effect.succeed(value), next]
    }).pipe(Effect.flatten)
  const claimFire: Service["claimFire"] = (fire) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (claimedAt) =>
        Ref.modify(state, (current): readonly [Effect.Effect<Claim, TriggerError>, State] => {
          const trigger = current.triggers.get(fire.triggerId)
          if (trigger === undefined) return [Effect.fail(unknown(fire.triggerId)), current]
          const decision = applyClaim(trigger, fire, current, claimedAt)
          return decision._tag === "Failure"
            ? [Effect.fail(decision.error), current]
            : [Effect.succeed(decision.claim), decision.state]
        }).pipe(Effect.flatten)
    )
  return TriggerStore.of({
    register: (trigger) =>
      Ref.modify(state, (current) => {
        const prior = current.triggers.get(trigger.id)
        const registered: Registered = {
          ...trigger,
          revision: (prior?.revision ?? 0) + 1,
          ...(prior?.lastFiredAt === undefined ? {} : { lastFiredAt: prior.lastFiredAt })
        }
        return [registered, { ...current, triggers: new Map(current.triggers).set(trigger.id, registered) }]
      }),
    get,
    list: () => Ref.get(state).pipe(Effect.map((current) => [...current.triggers.values()])),
    listEnabled: () =>
      Ref.get(state).pipe(Effect.map((current) => [...current.triggers.values()].filter((trigger) => trigger.enabled))),
    claimFire,
    claimPending: (fire) =>
      Effect.flatMap(Clock.currentTimeMillis, (claimedAt) =>
        Ref.modify(state, (current): readonly [
          ReturnType<Service["claimPending"]>,
          State
        ] => {
          const trigger = current.triggers.get(fire.triggerId)
          if (trigger === undefined) return [Effect.fail(unknown(fire.triggerId)), current]
          const occurrence = current.pending.get(fire.triggerId)
          if (occurrence === undefined) return [Effect.succeed(Option.none()), current]
          const decision = applyClaim(
            trigger,
            {
              triggerId: fire.triggerId,
              occurrence,
              expectedRevision: fire.expectedRevision,
              resumeBuffered: true
            },
            current,
            claimedAt
          )
          if (decision._tag === "Failure") return [Effect.fail(decision.error), current]
          let next = decision.state
          if (decision.claim.claimed) {
            const pending = new Map(decision.state.pending)
            pending.delete(fire.triggerId)
            next = { ...decision.state, pending }
          }
          return [Effect.succeed(Option.some({ occurrence, claim: decision.claim })), next]
        }).pipe(Effect.flatten)),
    recordResult: (result) =>
      requireTrigger(result.triggerId, (trigger, current) => {
        const triggers = new Map(current.triggers).set(result.triggerId, advanced(trigger, result.occurrence))
        const active = new Map(current.active)
        const activeClaimedAt = new Map(current.activeClaimedAt)
        const fires = new Map(current.fires)
        const fireKey = key(result.triggerId, result.occurrence)
        if (fires.has(fireKey)) fires.set(fireKey, result.outcome)
        if (result.outcome === "launched") {
          if (result.runId === undefined) active.delete(result.triggerId)
          else active.set(result.triggerId, result.runId)
          activeClaimedAt.delete(result.triggerId)
        } else if (
          result.outcome === "completed" ||
          result.outcome === "failed" ||
          result.outcome === "superseded"
        ) {
          const currentRunId = active.get(result.triggerId)
          if (result.runId === undefined || currentRunId === result.runId) {
            active.delete(result.triggerId)
            activeClaimedAt.delete(result.triggerId)
          }
        } else if (active.get(result.triggerId) === reservationId(result.triggerId, result.occurrence)) {
          active.delete(result.triggerId)
          activeClaimedAt.delete(result.triggerId)
        }
        return [undefined, { ...current, triggers, fires, active, activeClaimedAt }]
      }),
    setPending: (fire) =>
      requireTrigger(fire.triggerId, (_trigger, current) => {
        const pending = new Map(current.pending)
        pending.set(
          fire.triggerId,
          Overlap.pendingAfter({ running: true, pending: pending.get(fire.triggerId), due: fire.occurrence })
        )
        return [undefined, { ...current, pending }]
      }),
    takePending: (triggerId) =>
      requireTrigger(triggerId, (_trigger, current) => {
        const occurrence = current.pending.get(triggerId)
        const pending = new Map(current.pending)
        pending.delete(triggerId)
        return [occurrence === undefined ? Option.none() : Option.some(occurrence), { ...current, pending }]
      }),
    activeRun: (triggerId) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        requireTrigger(triggerId, (_trigger, current) => {
          const runId = current.active.get(triggerId)
          if (runId === undefined) return [Option.none(), current]
          const claimedAt = current.activeClaimedAt.get(triggerId)
          if (
            isReservation(runId) &&
            (claimedAt === undefined || claimedAt <= now - reservationLeaseMs)
          ) {
            const active = new Map(current.active)
            const activeClaimedAt = new Map(current.activeClaimedAt)
            const pending = new Map(current.pending)
            active.delete(triggerId)
            activeClaimedAt.delete(triggerId)
            const occurrence = Number(runId.slice(runId.lastIndexOf(":") + 1))
            if (current.fires.get(key(triggerId, occurrence)) === "buffered") {
              pending.set(
                triggerId,
                Overlap.pendingAfter({
                  running: false,
                  pending: pending.get(triggerId),
                  due: occurrence
                })
              )
            }
            return [Option.none(), { ...current, active, activeClaimedAt, pending }]
          }
          return [Option.some(runId), current]
        })),
    clearActive: (triggerId, runId) =>
      Ref.update(state, (current) => {
        if (current.active.get(triggerId) !== runId) return current
        const active = new Map(current.active)
        const activeClaimedAt = new Map(current.activeClaimedAt)
        active.delete(triggerId)
        activeClaimedAt.delete(triggerId)
        return { ...current, active, activeClaimedAt }
      })
  })
}))
