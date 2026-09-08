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
  compareNewestFirst,
  type FireRecord,
  type Heartbeat,
  historyLimit,
  historyPage,
  isAfterCursor,
  isReservation,
  type Outcome,
  type Registered,
  reservationId,
  reservationLeaseMs,
  reservationOccurrence,
  type Service,
  TriggerStore
} from "../TriggerStore.ts"

/**
 * The columns the SQL store keeps on `flows_triggers` and `flows_trigger_fires`,
 * spread across maps so one trigger's state can be replaced without copying the
 * rest.
 *
 * Two invariants let the readers below index without a fallback, and both are
 * written by this module alone:
 *
 * - `active` and `activeOccurrences` are set and deleted together, so a trigger
 *   with an active run or reservation always has the occurrence that claimed it.
 *   `activeClaimedAt` is deliberately not part of that pair: a launch drops the
 *   claim timestamp while keeping the run, which is how the SQL store spells a
 *   reservation that predates the lease column.
 * - `fireRunIds` names a run only for a fire that a claim or a result attached
 *   one to, and every such run was recorded `launched` first, so
 *   `runOccurrences` knows the occurrence it belongs to.
 *
 * `fireErrors` and `heartbeats` are the SQL store's `error` column and its
 * `flows_scheduler_heartbeat` table.
 */
interface State {
  readonly triggers: ReadonlyMap<string, Registered>
  readonly fires: ReadonlyMap<string, Outcome | null>
  readonly fireRunIds: ReadonlyMap<string, string>
  readonly fireErrors: ReadonlyMap<string, string>
  readonly heartbeats: ReadonlyMap<string, number>
  readonly runOccurrences: ReadonlyMap<string, number>
  readonly pending: ReadonlyMap<string, number>
  readonly active: ReadonlyMap<string, string>
  readonly activeOccurrences: ReadonlyMap<string, number>
  readonly activeClaimedAt: ReadonlyMap<string, number>
}

const key = (triggerId: string, occurrence: number) => `${triggerId}:${occurrence}`

// The occurrence is the numeric tail, so a trigger id holding a colon still
// splits at the right place.
const fireRecord = (current: State, fireKey: string, outcome: Outcome | null): FireRecord => {
  const at = fireKey.lastIndexOf(":")
  const runId = current.fireRunIds.get(fireKey)
  const error = current.fireErrors.get(fireKey)
  return {
    triggerId: fireKey.slice(0, at),
    occurrence: Number(fireKey.slice(at + 1)),
    outcome,
    ...(runId === undefined ? {} : { runId }),
    ...(error === undefined ? {} : { error })
  }
}
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
  const existingRunId = current.fireRunIds.get(fireKey)
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
    const resumableSupersede = fire.resumeBuffered === true && existingOutcome === null &&
      trigger.overlap === "supersede" && activeRunId !== undefined && existingRunId === activeRunId
    if (!resumableBuffer && !resumableReservation && !resumableSupersede) {
      return { _tag: "Success", claim: { claimed: false }, state: current }
    }
  }

  const active = new Map(current.active)
  const activeOccurrences = new Map(current.activeOccurrences)
  const activeClaimedAt = new Map(current.activeClaimedAt)
  const fires = new Map(current.fires)
  const fireRunIds = new Map(current.fireRunIds)
  const pending = new Map(current.pending)
  if (expiredReservation !== undefined) {
    activeClaimedAt.delete(fire.triggerId)
    const expiredOccurrence = current.activeOccurrences.get(fire.triggerId) as number
    const expiredOutcome = current.fires.get(key(fire.triggerId, expiredOccurrence))
    if (expiredOutcome === null || expiredOutcome === "buffered") {
      if (trigger.overlap === "supersede") {
        const predecessor = current.fireRunIds.get(key(fire.triggerId, expiredOccurrence))
        if (predecessor !== undefined) {
          active.set(fire.triggerId, predecessor)
          activeOccurrences.set(fire.triggerId, current.runOccurrences.get(predecessor) as number)
          activeRunId = predecessor
        } else {
          active.delete(fire.triggerId)
          activeOccurrences.delete(fire.triggerId)
          activeRunId = undefined
        }
        if (expiredOccurrence !== fire.occurrence) {
          fires.set(key(fire.triggerId, expiredOccurrence), "superseded")
        }
      } else {
        active.delete(fire.triggerId)
        activeOccurrences.delete(fire.triggerId)
        activeRunId = undefined
        if (expiredOccurrence !== fire.occurrence) {
          pending.set(
            fire.triggerId,
            Overlap.pendingAfter({ running: false, pending: pending.get(fire.triggerId), due: expiredOccurrence })
          )
        }
      }
    } else {
      active.delete(fire.triggerId)
      activeOccurrences.delete(fire.triggerId)
      activeRunId = undefined
    }
  }
  const overlapState: Overlap.State = {
    running: activeRunId !== undefined,
    pending: pending.get(fire.triggerId),
    due: fire.occurrence
  }
  const action = Overlap.decide(trigger.overlap, overlapState)
  if (!fireExists) fires.set(fireKey, null)
  // A skip or buffer is complete inside the claim transaction. A fire or
  // supersede is only reserved here; its cursor advances when `recordResult`
  // makes the launched run durable, matching the SQL store.
  const triggers = action === "skip" || action === "buffer"
    ? new Map(current.triggers).set(fire.triggerId, advanced(trigger, fire.occurrence))
    : current.triggers
  if (action === "skip" || action === "buffer") {
    fires.set(fireKey, action === "skip" ? "skipped" : "buffered")
    if (action === "buffer") pending.set(fire.triggerId, Overlap.pendingAfter(overlapState))
    return {
      _tag: "Success",
      claim: { claimed: true, action },
      state: { ...current, fires, fireRunIds, active, activeOccurrences, activeClaimedAt, pending, triggers }
    }
  }
  let supersededRunId = activeRunId
  if (action === "supersede" && activeRunId !== undefined) {
    if (isReservation(activeRunId)) {
      const activeOccurrence = current.activeOccurrences.get(fire.triggerId) as number
      const predecessor = current.fireRunIds.get(key(fire.triggerId, activeOccurrence))
      if (predecessor !== undefined) {
        supersededRunId = predecessor
        fires.set(key(fire.triggerId, activeOccurrence), "superseded")
      }
    }
    if (supersededRunId !== undefined && !isReservation(supersededRunId)) {
      fireRunIds.set(fireKey, supersededRunId)
    }
  }
  active.set(fire.triggerId, reservation)
  activeOccurrences.set(fire.triggerId, fire.occurrence)
  activeClaimedAt.set(fire.triggerId, claimedAt)
  return {
    _tag: "Success",
    claim: {
      claimed: true,
      action,
      reservationId: reservation,
      ...(supersededRunId === undefined ? {} : { activeRunId: supersededRunId })
    },
    state: { ...current, fires, fireRunIds, active, activeOccurrences, activeClaimedAt, pending, triggers }
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
    fireRunIds: new Map(),
    fireErrors: new Map(),
    heartbeats: new Map(),
    runOccurrences: new Map(),
    pending: new Map(),
    active: new Map(),
    activeOccurrences: new Map(),
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
          if (decision.claim.claimed && decision.claim.action !== "buffer") {
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
        const activeOccurrences = new Map(current.activeOccurrences)
        const activeClaimedAt = new Map(current.activeClaimedAt)
        const fires = new Map(current.fires)
        const fireRunIds = new Map(current.fireRunIds)
        const fireErrors = new Map(current.fireErrors)
        const runOccurrences = new Map(current.runOccurrences)
        const fireKey = key(result.triggerId, result.occurrence)
        const recordedRunId = current.fireRunIds.get(fireKey)
        const terminal = result.outcome === "completed" ||
          result.outcome === "failed" ||
          result.outcome === "superseded"
        if (fires.has(fireKey)) {
          fires.set(fireKey, result.outcome)
          if (result.runId !== undefined) fireRunIds.set(fireKey, result.runId)
          else if (!terminal) fireRunIds.delete(fireKey)
          // The SQL store overwrites the error column on every result.
          if (result.error === undefined) fireErrors.delete(fireKey)
          else fireErrors.set(fireKey, result.error)
        }
        if (result.outcome === "launched") {
          if (result.runId === undefined) {
            active.delete(result.triggerId)
            activeOccurrences.delete(result.triggerId)
          } else {
            active.set(result.triggerId, result.runId)
            activeOccurrences.set(result.triggerId, result.occurrence)
            runOccurrences.set(result.runId, result.occurrence)
          }
          activeClaimedAt.delete(result.triggerId)
        } else if (terminal) {
          const currentRunId = active.get(result.triggerId)
          const resultOwner = result.runId ?? recordedRunId ?? reservationId(result.triggerId, result.occurrence)
          if (currentRunId === resultOwner) {
            active.delete(result.triggerId)
            activeOccurrences.delete(result.triggerId)
            activeClaimedAt.delete(result.triggerId)
          }
        } else if (active.get(result.triggerId) === reservationId(result.triggerId, result.occurrence)) {
          active.delete(result.triggerId)
          activeOccurrences.delete(result.triggerId)
          activeClaimedAt.delete(result.triggerId)
        }
        return [
          undefined,
          {
            ...current,
            triggers,
            fires,
            fireRunIds,
            fireErrors,
            runOccurrences,
            active,
            activeOccurrences,
            activeClaimedAt
          }
        ]
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
            const activeOccurrences = new Map(current.activeOccurrences)
            const activeClaimedAt = new Map(current.activeClaimedAt)
            const pending = new Map(current.pending)
            activeClaimedAt.delete(triggerId)
            const occurrence = current.activeOccurrences.get(triggerId) as number
            const outcome = current.fires.get(key(triggerId, occurrence))
            if (outcome === null || outcome === "buffered") {
              pending.set(
                triggerId,
                Overlap.pendingAfter({
                  running: false,
                  pending: pending.get(triggerId),
                  due: occurrence
                })
              )
              const predecessor = current.fireRunIds.get(key(triggerId, occurrence))
              if (predecessor !== undefined && !isReservation(predecessor)) {
                active.set(triggerId, predecessor)
                activeOccurrences.set(triggerId, current.runOccurrences.get(predecessor) as number)
                return [
                  Option.some(predecessor),
                  { ...current, active, activeOccurrences, activeClaimedAt, pending }
                ]
              }
            }
            active.delete(triggerId)
            activeOccurrences.delete(triggerId)
            return [Option.none(), { ...current, active, activeOccurrences, activeClaimedAt, pending }]
          }
          return [Option.some(runId), current]
        })),
    activeOccurrence: (triggerId, runId) =>
      requireTrigger(triggerId, (_trigger, current) => {
        const reserved = reservationOccurrence(runId)
        const launched = current.runOccurrences.get(runId)
        const occurrence = reserved ??
          (launched !== undefined && current.fires.get(key(triggerId, launched)) === "launched" ? launched : undefined)
        return [occurrence === undefined ? Option.none() : Option.some(occurrence), current]
      }),
    clearActive: (triggerId, runId) =>
      Ref.update(state, (current) => {
        if (current.active.get(triggerId) !== runId) return current
        const active = new Map(current.active)
        const activeOccurrences = new Map(current.activeOccurrences)
        const activeClaimedAt = new Map(current.activeClaimedAt)
        active.delete(triggerId)
        activeOccurrences.delete(triggerId)
        activeClaimedAt.delete(triggerId)
        return { ...current, active, activeOccurrences, activeClaimedAt }
      }),
    history: (query = {}) =>
      Effect.flatMap(historyLimit(query.limit), (limit) =>
        Ref.get(state).pipe(Effect.map((current) => {
          const records = [...current.fires.entries()]
            .map(([fireKey, outcome]) => fireRecord(current, fireKey, outcome))
            .filter((record) =>
              (query.triggerId === undefined || record.triggerId === query.triggerId) &&
              (query.runId === undefined || record.runId === query.runId) &&
              (query.outcome === undefined || record.outcome === query.outcome) &&
              (query.cursor === undefined || isAfterCursor(record, query.cursor))
            )
            .sort(compareNewestFirst)
          return historyPage(records, limit)
        }))),
    inspect: (triggerId) =>
      requireTrigger(triggerId, (_trigger, current) => {
        const activeRunId = current.active.get(triggerId)
        const pendingAt = current.pending.get(triggerId)
        return [
          {
            ...(activeRunId === undefined ? {} : { activeRunId }),
            ...(pendingAt === undefined ? {} : { pendingAt })
          },
          current
        ]
      }),
    heartbeat: (host) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (tickedAt) =>
          Ref.update(state, (current) => ({ ...current, heartbeats: new Map(current.heartbeats).set(host, tickedAt) }))
      ),
    lastHeartbeat: () =>
      Ref.get(state).pipe(Effect.map((current) => {
        let latest: Heartbeat | undefined
        for (const [host, tickedAt] of current.heartbeats) {
          // Newest wins; equal times fall to the lower host name, as the SQL
          // store's ORDER BY does.
          if (
            latest === undefined || tickedAt > latest.tickedAt || (tickedAt === latest.tickedAt && host < latest.host)
          ) {
            latest = { host, tickedAt }
          }
        }
        return latest === undefined ? Option.none() : Option.some(latest)
      }))
  })
}))
