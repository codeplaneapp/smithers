/** Request admission uses captured JJ source facts, never a silently refreshed tip. */
import { Action } from "@smthrs/flow"
import { Effect } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "./native.ts"
import { sameCode } from "./planning.ts"
import { CodingError, Plan, validatePlan } from "./schema.ts"

export const AdmitSource = Action.make("coding/admit-prepared-source", {
  payload: { plan: Plan }, success: Plan, error: CodingError, nondeterministic: true
})

/** The existing per-operation native fences still guard every later mutation. */
export const admitSource = (plan: Plan) => Effect.gen(function*() {
  yield* Effect.try({ try: () => validatePlan(plan), catch: error => error instanceof CodingError ? error :
    new CodingError({ code: "invalid_plan", message: String(error) }) })
  if (!plan.observedHead) return yield* new CodingError({ code: "stale_revision",
    message: "This request needs the observed native source head; prepare a new plan" })
  const jj = yield* Jj.Jj, native = yield* NativeCoding
  yield* jj.snapshot("coding request source admission")
  const current = yield* native.read([...new Set([plan.base.changeId, plan.observedHead.changeId])])
  const base = current.revisions.find(row => row.changeId === plan.base.changeId)
  if (current.head.kind !== "resolved" || !sameCode(current.head, plan.observedHead) ||
      !base || base.kind !== "resolved" || !sameCode(base, plan.base)) {
    return yield* new CodingError({ code: "stale_revision", message: "Native source changed after this plan; gather and plan again before implementation" })
  }
  return plan
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : new CodingError({
  code: "stale_revision", message: "Prepared source could not be verified: " + (error instanceof Error ? error.message : String(error))
})))

export const sourceAdmission = AdmitSource.toLayer(({ plan }) => admitSource(plan))
