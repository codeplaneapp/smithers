// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Declares how a flow is about to wait before it suspends.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { FlowInstance } from "./FlowInstance.ts"

/**
 * The waiting classification a flow can declare before suspending.
 *
 * Mirrors the durable store's waiting payload: `reason` is the supervisor
 * vocabulary (`approval`, `event`, `timer`, `quota`, or a plugin-defined
 * reason), `wakeAt` an absolute deadline, and `token` compare-and-swap
 * material a wake handler matches against.
 *
 * @category models
 * @since 0.1.0
 */
export interface WaitingAnnotation {
  readonly reason: string
  readonly wakeAt?: number | undefined
  readonly token?: string | undefined
}

/**
 * Declares how the flow is about to wait, so a durable driver parks the run
 * with that reason and token instead of the derived `timer`/`event` default.
 *
 * The annotation is scoped to the wait it precedes: once the awaited
 * deferred passes through with a persisted result — including replays after
 * the wait resolved — the declared classification is consumed, so a later
 * suspension parks under its own reason (and keeps its timer `wakeAt`)
 * instead of the stale one (issue #42).
 *
 * Call it immediately before awaiting the deferred that models the wait:
 *
 * ```ts
 * yield* FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })
 * const decision = yield* DurableDeferred.await(approvalGate)
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const annotateWaiting = (
  waiting: WaitingAnnotation | undefined
): Effect.Effect<void, never, FlowInstance> =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    instance.waiting = waiting
  })
