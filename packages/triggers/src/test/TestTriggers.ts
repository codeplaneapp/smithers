/** @since 0.1.0 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Overlap from "../Overlap.ts"
import { TriggerError } from "../TriggerError.ts"
import { type Claim, type Registered, type Service, TriggerStore } from "../TriggerStore.ts"

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
    due: (_now) =>
      Ref.get(state).pipe(Effect.map((current) => [...current.triggers.values()].filter((trigger) => trigger.enabled))),
    claimFire: (fire) =>
      Ref.modify(state, (current): readonly [Claim, State] => {
        const fireKey = key(fire.triggerId, fire.occurrence)
        if (current.fires.has(fireKey) && fire.resumeBuffered !== true) {
          return [{ claimed: false as const }, current]
        }
        const activeRunId = current.active.get(fire.triggerId)
        const action = Overlap.decide(fire.overlap, {
          running: activeRunId !== undefined,
          due: fire.occurrence
        })
        const fires = new Set(current.fires).add(fireKey)
        const active = new Map(current.active)
        const pending = new Map(current.pending)
        const triggers = new Map(current.triggers)
        const trigger = triggers.get(fire.triggerId)
        if (trigger !== undefined) {
          triggers.set(fire.triggerId, { ...trigger, lastFiredAt: fire.occurrence })
        }
        if (action === "buffer") {
          pending.set(
            fire.triggerId,
            Math.max(pending.get(fire.triggerId) ?? Number.NEGATIVE_INFINITY, fire.occurrence)
          )
        }
        const reservationId = `trigger-reservation:${fire.triggerId}:${fire.occurrence}`
        if (action === "fire" || action === "supersede") active.set(fire.triggerId, reservationId)
        return [{
          claimed: true as const,
          action,
          ...(action === "fire" || action === "supersede" ? { reservationId } : {}),
          ...(activeRunId === undefined ? {} : { activeRunId })
        }, { ...current, fires, active, pending, triggers }]
      }),
    recordResult: (result) =>
      Ref.modify(state, (current) => {
        const trigger = current.triggers.get(result.triggerId)
        if (trigger === undefined) return [undefined, current]
        const triggers = new Map(current.triggers).set(result.triggerId, { ...trigger, lastFiredAt: result.occurrence })
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
        } else if (
          active.get(result.triggerId) ===
            `trigger-reservation:${result.triggerId}:${result.occurrence}`
        ) {
          active.delete(result.triggerId)
        }
        return [undefined, { ...current, triggers, active }]
      }).pipe(
        Effect.flatMap(() => get(result.triggerId)),
        Effect.flatMap((trigger) => Option.isNone(trigger) ? Effect.fail(unknown(result.triggerId)) : Effect.void)
      ),
    setPending: (fire) =>
      Ref.modify(state, (current) => {
        if (!current.triggers.has(fire.triggerId)) return [false, current]
        const pending = new Map(current.pending)
        pending.set(fire.triggerId, Math.max(pending.get(fire.triggerId) ?? Number.NEGATIVE_INFINITY, fire.occurrence))
        return [true, { ...current, pending }]
      }).pipe(Effect.flatMap((found) => found ? Effect.void : Effect.fail(unknown(fire.triggerId)))),
    takePending: (triggerId) =>
      Ref.modify(state, (current) => {
        const occurrence = current.pending.get(triggerId)
        const pending = new Map(current.pending)
        pending.delete(triggerId)
        return [occurrence === undefined ? Option.none() : Option.some(occurrence), { ...current, pending }]
      }),
    activeRun: (triggerId) =>
      Ref.get(state).pipe(Effect.map((current) => {
        const runId = current.active.get(triggerId)
        return runId === undefined ? Option.none() : Option.some(runId)
      })),
    clearActive: (triggerId, runId) =>
      Ref.update(state, (current) => {
        if (current.active.get(triggerId) !== runId) return current
        const active = new Map(current.active)
        active.delete(triggerId)
        return { ...current, active }
      })
  })
}))
