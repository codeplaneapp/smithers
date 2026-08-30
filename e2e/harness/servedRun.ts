/**
 * A run on a served control plane, planned and launched over the wire.
 *
 * Every gateway case needs the same three round trips before it can assert
 * anything: plan, approve, launch. They are here so a case reads as the fault
 * it injects rather than as its setup.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"

/**
 * Plans, approves, and launches `system/test`, returning the run id.
 *
 * @since 1.0.0
 * @category constructors
 */
export const launchRun = (label: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan({ flowId: "system/test", input: { case: label } })
    yield* control.approve({
      target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
      scope: card.approval.scope,
      idempotencyKey: `approve:${card.planId}`
    })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${card.planId}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die(new Error(`expected an accepted run, got ${receipt._tag}`))
    }
    return { runId: receipt.runId, card }
  })

/**
 * Delivers `count` signals to `runId`, one journal event each.
 *
 * @since 1.0.0
 * @category constructors
 */
export const emitSignals = (runId: string, count: number, prefix = "tick") =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    for (let index = 0; index < count; index += 1) {
      yield* control.signal({
        runId,
        signal: { name: prefix, payload: { index } } as never,
        idempotencyKey: `${prefix}:${runId}:${index}`
      })
    }
  })
