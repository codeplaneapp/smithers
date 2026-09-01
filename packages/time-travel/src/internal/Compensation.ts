/**
 * Tier-aware rewind preflight, compensation, and rollback.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { EffectRecord } from "../EffectBoundary.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import type { Receipt } from "../TimeTravelStore.ts"
import { Assessment as HandlerAssessment, EffectHandlerRegistry, RollbackReceipt } from "./EffectHandlerRegistry.ts"

/**
 * One complete preflight decision for a crossed effect.
 *
 * @since 0.1.0
 * @category models
 */
export const Assessment = Schema.Struct({ ...HandlerAssessment.fields, effect: EffectRecord })
/**
 * The value form of {@link Assessment}.
 *
 * @since 0.1.0
 * @category models
 */
export type Assessment = typeof Assessment.Type

/**
 * Immutable compensation plan. All cache reads and handler resolution have
 * completed before this value is produced.
 *
 * @since 0.1.0
 * @category models
 */
export const Plan = Schema.Struct({
  effects: Schema.Array(EffectRecord),
  assessments: Schema.Array(Assessment),
  targetChangeId: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link Plan}.
 *
 * @since 0.1.0
 * @category models
 */
export type Plan = typeof Plan.Type

/**
 * Receipt for restoring the workspace to the target frame.
 *
 * @since 0.1.0
 * @category models
 */
export const WorkspaceReceipt = Schema.Struct({
  currentChangeId: Schema.NonEmptyString,
  targetChangeId: Schema.NonEmptyString
})
/**
 * The value form of {@link WorkspaceReceipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type WorkspaceReceipt = typeof WorkspaceReceipt.Type

/**
 * All reversible mutations performed before journal truncation.
 *
 * @since 0.1.0
 * @category models
 */
export const Result = Schema.Struct({
  handlerReceipts: Schema.Array(RollbackReceipt),
  workspace: Schema.optionalKey(WorkspaceReceipt)
})
/**
 * The value form of {@link Result}.
 *
 * @since 0.1.0
 * @category models
 */
export type Result = typeof Result.Type

const sealedAssessment = (
  effect: EffectRecord,
  classification: "warning" | "blocking",
  reason: string
): Assessment => ({
  effect,
  classification,
  reason,
  residue: effect.residue ?? "The sealed result cannot be re-derived without its recorded cache entry."
})

const compensableAssessment = (
  effect: EffectRecord,
  targetChangeId: string | undefined
): Assessment =>
  targetChangeId === undefined
    ? {
      effect,
      classification: "blocking",
      reason: "The target frame has no recorded jj snapshot pointer.",
      residue: "Workspace mutations cannot be restored to the selected frame."
    }
    : {
      effect,
      classification: "revertible",
      reason: `The workspace will be restored to jj change ${targetChangeId}.`,
      residue: "Workspace state after the target frame is discarded into jj history."
    }

/**
 * Resolves every crossed effect before any compensation or workspace mutation.
 *
 * Sealed entries must be present in `CacheStore`; this preflight never invokes
 * their producer. Compensable entries require the target frame's jj pointer.
 * Irreversible entries delegate to the immutable handler registry.
 *
 * @since 0.1.0
 * @category constructors
 */
export const assess = (
  effects: ReadonlyArray<EffectRecord>,
  targetChangeId?: string | undefined
): Effect.Effect<
  Plan,
  TimeTravelError,
  CacheStore.CacheStore | EffectHandlerRegistry
> =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    const registry = yield* EffectHandlerRegistry
    const assessments: Array<Assessment> = []
    const ordered = [...effects].sort((left, right) => left.seq - right.seq)

    for (const effect of ordered) {
      if (effect.tier === "sealed") {
        if (effect.cacheKey === undefined) {
          assessments.push(
            sealedAssessment(effect, "blocking", "The sealed effect has no content-addressed cache key.")
          )
          continue
        }
        const cached = yield* cache.get(effect.cacheKey).pipe(
          Effect.mapError((cause) => error("unknown", `could not consult sealed result ${effect.cacheKey}`, cause))
        )
        assessments.push(
          Option.isSome(cached)
            ? sealedAssessment(effect, "warning", "The sealed result is present and replay remains a cache hit.")
            : sealedAssessment(effect, "blocking", `Sealed cache entry ${effect.cacheKey} is missing.`)
        )
        continue
      }

      if (effect.tier === "compensable") {
        assessments.push(compensableAssessment(effect, targetChangeId))
        continue
      }

      const handlerAssessment = yield* registry.assess(effect)
      assessments.push({ effect, ...handlerAssessment })
    }

    return {
      effects: ordered,
      assessments,
      ...(targetChangeId === undefined ? {} : { targetChangeId })
    }
  })

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  return squashed instanceof Error ? squashed.message : String(squashed)
}

const rollbackHandlers = (
  registry: EffectHandlerRegistry["Service"],
  receipts: ReadonlyArray<RollbackReceipt>
): Effect.Effect<void, TimeTravelError> =>
  Effect.gen(function*() {
    const failures: Array<TimeTravelError> = []
    for (const receipt of [...receipts].reverse()) {
      const rollbackExit = yield* Effect.exit(registry.rollback(receipt))
      if (Exit.isFailure(rollbackExit)) {
        failures.push(
          error(
            "compensation_failed",
            `could not roll back compensation for ${receipt.effect.id}: ${causeMessage(rollbackExit.cause)}`,
            rollbackExit.cause
          )
        )
      }
    }
    if (failures.length > 0) {
      return yield* Effect.fail(
        error("compensation_failed", `${failures.length} compensation rollback operation(s) failed`, failures)
      )
    }
  })

const assertExecutable = (plan: Plan): Effect.Effect<void, TimeTravelError> => {
  const blocking = plan.assessments.filter((assessment) => assessment.classification === "blocking")
  return blocking.length === 0
    ? Effect.void
    : Effect.fail(
      error(
        "irreversible",
        `rewind is blocked by ${blocking.length} crossed effect(s)`,
        blocking
      )
    )
}

/**
 * Runs resolved tier-3 handlers in reverse journal order.
 *
 * A handler failure rolls back every earlier handler receipt before the typed
 * failure escapes.
 *
 * @since 0.1.0
 * @category compensation
 */
export const compensate = (
  plan: Plan
): Effect.Effect<
  ReadonlyArray<RollbackReceipt>,
  TimeTravelError,
  EffectHandlerRegistry
> =>
  Effect.gen(function*() {
    yield* assertExecutable(plan)
    const registry = yield* EffectHandlerRegistry
    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const receipts: Array<RollbackReceipt> = []
        const effects = plan.assessments
          .filter(
            (assessment) =>
              assessment.effect.tier === "irreversible" &&
              assessment.classification === "revertible"
          )
          .map((assessment) => assessment.effect)
          .sort((left, right) => right.seq - left.seq)

        for (const effect of effects) {
          const revertExit = yield* Effect.exit(registry.revert(effect))
          if (Exit.isFailure(revertExit)) {
            const rollbackExit = yield* Effect.exit(rollbackHandlers(registry, receipts))
            return yield* Effect.fail(
              error(
                "compensation_failed",
                `could not compensate ${effect.id}: ${causeMessage(revertExit.cause)}`,
                {
                  compensation: revertExit.cause,
                  rollback: Exit.isFailure(rollbackExit) ? rollbackExit.cause : undefined
                }
              )
            )
          }
          receipts.push(revertExit.value)
        }
        return receipts
      })
    )
  })

/**
 * Snapshots the current jj state and restores the target pointer after tier-3
 * compensation.
 *
 * The caller hands ownership of `handlerReceipts` over with the call: EVERY
 * failure path here rolls them back before the failure escapes, so the caller
 * must not roll them back again. Nothing requires a handler's `rollback` to be
 * idempotent, so a second pass would re-perform the side effect the revert
 * undid. The two refusals that never touch jj — a plan that is not executable,
 * and a plan that needs a restore with no pointer resolved — are covered by
 * that rule too, so it is one invariant rather than a list of exceptions the
 * caller has to track.
 *
 * @since 0.1.0
 * @category compensation
 */
export const restoreWorkspace = (
  plan: Plan,
  handlerReceipts: ReadonlyArray<RollbackReceipt>
): Effect.Effect<Result, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.gen(function*() {
    const registry = yield* EffectHandlerRegistry
    // A cleanup failure on these two paths is logged rather than folded into
    // the refusal: both mean the plan itself was malformed before any jj work
    // started, and that is what the caller has to be told about.
    const cleanUp = rollbackHandlers(registry, handlerReceipts).pipe(
      Effect.catchCause((cause) => Effect.logError("time-travel: rollback after a refused restore failed", cause))
    )
    yield* assertExecutable(plan).pipe(Effect.tapError(() => cleanUp))
    const jj = yield* Jj
    const needsRestore = plan.effects.some((effect) => effect.tier === "compensable")
    if (!needsRestore) return { handlerReceipts }
    if (plan.targetChangeId === undefined) {
      yield* cleanUp
      return yield* Effect.fail(error("compensation_failed", "target jj pointer was not resolved during preflight"))
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const currentExit = yield* Effect.exit(jj.snapshot("flows rewind pre-restore"))
        if (Exit.isFailure(currentExit)) {
          const handlerRollback = yield* Effect.exit(rollbackHandlers(registry, handlerReceipts))
          return yield* Effect.fail(
            error(
              "compensation_failed",
              `could not snapshot current jj state: ${causeMessage(currentExit.cause)}`,
              Exit.isFailure(handlerRollback)
                ? { snapshot: currentExit.cause, handlerRollback: handlerRollback.cause }
                : currentExit.cause
            )
          )
        }

        const workspace: WorkspaceReceipt = {
          currentChangeId: currentExit.value.changeId,
          targetChangeId: plan.targetChangeId!
        }
        const restoreExit = yield* Effect.exit(jj.restore(workspace.targetChangeId))
        if (Exit.isFailure(restoreExit)) {
          const workspaceRollback = yield* Effect.exit(jj.restore(workspace.currentChangeId))
          const handlerRollback = yield* Effect.exit(rollbackHandlers(registry, handlerReceipts))
          return yield* Effect.fail(
            error(
              "compensation_failed",
              `could not restore jj state ${workspace.targetChangeId}: ${causeMessage(restoreExit.cause)}`,
              {
                restore: restoreExit.cause,
                workspaceRollback: Exit.isFailure(workspaceRollback) ? workspaceRollback.cause : undefined,
                handlerRollback: Exit.isFailure(handlerRollback) ? handlerRollback.cause : undefined
              }
            )
          )
        }

        return { handlerReceipts, workspace }
      })
    )
  })

/**
 * Runs tier-3 compensation and then tier-2 workspace restoration.
 *
 * @since 0.1.0
 * @category compensation
 */
export const execute = (
  plan: Plan
): Effect.Effect<Result, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.uninterruptible(
    compensate(plan).pipe(
      Effect.flatMap((receipts) => restoreWorkspace(plan, receipts))
    )
  )

/**
 * Reverses every mutation represented by a compensation result.
 *
 * Workspace restoration is undone first, followed by handler receipts in the
 * reverse of their execution order.
 *
 * @since 0.1.0
 * @category compensation
 */
export const rollback = (
  result: Result
): Effect.Effect<void, TimeTravelError, EffectHandlerRegistry | Jj> =>
  Effect.gen(function*() {
    const registry = yield* EffectHandlerRegistry
    const jj = yield* Jj
    return yield* Effect.uninterruptible(
      Effect.gen(function*() {
        const failures: Array<unknown> = []
        if (result.workspace !== undefined) {
          const workspaceExit = yield* Effect.exit(jj.restore(result.workspace.currentChangeId))
          if (Exit.isFailure(workspaceExit)) failures.push(workspaceExit.cause)
        }
        const handlerExit = yield* Effect.exit(rollbackHandlers(registry, result.handlerReceipts))
        if (Exit.isFailure(handlerExit)) failures.push(handlerExit.cause)
        if (failures.length > 0) {
          return yield* Effect.fail(
            error("compensation_failed", `${failures.length} rewind rollback operation(s) failed`, failures)
          )
        }
      })
    )
  })

/**
 * Converts handler receipts to the public store shape for atomic archival.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toStoreReceipts = (
  auditId: string,
  result: Result
): ReadonlyArray<Receipt> =>
  result.handlerReceipts.map((receipt) => ({
    id: `${auditId}:${receipt.id}`,
    auditId,
    effectId: receipt.effect.id,
    receipt
  }))
