/** @since 0.1.0 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Overlap from "../Overlap.ts"
import { TriggerError } from "../TriggerError.ts"
import {
  type Claim,
  type ClaimFire,
  type Registered,
  reservationId,
  type Service,
  TriggerStore
} from "../TriggerStore.ts"

interface State {
  readonly triggers: ReadonlyMap<string, Registered>
  readonly fires: ReadonlySet<string>
  readonly pending: ReadonlyMap<string, number>
  readonly active: ReadonlyMap<string, string>
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

/**
 * Provides an in-memory {@link TriggerStore} for tests: real claim and
 * overlap semantics, no database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<TriggerStore> = Layer.effect(TriggerStore)(Effect.gen(function*() {
  const state = yield* Ref.make<State>({ triggers: new Map(), fires: new Set(), pending: new Map(), active: new Map() })
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
    claimFire: (fire) =>
      Ref.modify(state, (current): readonly [Effect.Effect<Claim, TriggerError>, State] => {
        const trigger = current.triggers.get(fire.triggerId)
        if (trigger === undefined) return [Effect.fail(unknown(fire.triggerId)), current]
        const refusal = refuseClaim(trigger, fire)
        if (refusal !== undefined) return [Effect.fail(refusal), current]
        const fireKey = key(fire.triggerId, fire.occurrence)
        if (current.fires.has(fireKey) && fire.resumeBuffered !== true) {
          return [Effect.succeed({ claimed: false as const }), current]
        }
        const activeRunId = current.active.get(fire.triggerId)
        const overlapState: Overlap.State = {
          running: activeRunId !== undefined,
          pending: current.pending.get(fire.triggerId),
          due: fire.occurrence
        }
        const action = Overlap.decide(trigger.overlap, overlapState)
        const fires = new Set(current.fires).add(fireKey)
        const active = new Map(current.active)
        const pending = new Map(current.pending)
        const triggers = new Map(current.triggers).set(fire.triggerId, advanced(trigger, fire.occurrence))
        if (action === "buffer") pending.set(fire.triggerId, Overlap.pendingAfter(overlapState))
        const reservation = reservationId(fire.triggerId, fire.occurrence)
        const next = { ...current, fires, active, pending, triggers }
        if (action === "skip" || action === "buffer") {
          return [Effect.succeed<Claim>({ claimed: true, action }), next]
        }
        active.set(fire.triggerId, reservation)
        return [
          Effect.succeed<Claim>({
            claimed: true,
            action,
            reservationId: reservation,
            ...(activeRunId === undefined ? {} : { activeRunId })
          }),
          next
        ]
      }).pipe(Effect.flatten),
    recordResult: (result) =>
      requireTrigger(result.triggerId, (trigger, current) => {
        const triggers = new Map(current.triggers).set(result.triggerId, advanced(trigger, result.occurrence))
        const active = new Map(current.active)
        if (result.outcome === "launched" && result.runId !== undefined) {
          active.set(result.triggerId, result.runId)
        } else if (
          result.outcome === "completed" ||
          result.outcome === "failed" ||
          result.outcome === "superseded"
        ) {
          const currentRunId = active.get(result.triggerId)
          if (result.runId === undefined || currentRunId === result.runId) active.delete(result.triggerId)
        } else if (active.get(result.triggerId) === reservationId(result.triggerId, result.occurrence)) {
          active.delete(result.triggerId)
        }
        return [undefined, { ...current, triggers, active }]
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
      requireTrigger(triggerId, (_trigger, current) => {
        const runId = current.active.get(triggerId)
        return [runId === undefined ? Option.none() : Option.some(runId), current]
      }),
    clearActive: (triggerId, runId) =>
      Ref.update(state, (current) => {
        if (current.active.get(triggerId) !== runId) return current
        const active = new Map(current.active)
        active.delete(triggerId)
        return { ...current, active }
      })
  })
}))
