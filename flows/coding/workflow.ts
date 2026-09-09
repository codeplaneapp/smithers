/** Linear implementation with a parallel slow-validation branch at every Change. */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import {
  Change, Check, CodingError, Implementation, Plan, Receipt, Result, Revision,
  ValidatedChange, receiptMatches, sameRevision, validatePlan
} from "./schema.ts"

/** These leaves are implemented by existing project flows and repository/build hosts. */
export const ValidatePlan = Action.make("coding/validate-plan", {
  payload: { plan: Plan }, success: Plan, error: CodingError
})
export const Implement = Action.make("coding/implement-change", {
  payload: { change: Change, parent: Revision, memoryRevision: Schema.NonEmptyString },
  success: Implementation, error: CodingError, nondeterministic: true
})
export const RunCheck = Action.make("coding/check", {
  payload: { implementation: Implementation, check: Check },
  success: Receipt, error: CodingError
})
export const FastGate = Action.make("coding/fast-gate", {
  payload: { change: Change, parent: Revision, implementation: Implementation, receipts: Schema.Record(Schema.String, Receipt) },
  success: ValidatedChange, error: CodingError
})
export const Assess = Action.make("coding/assess", {
  payload: { plan: Plan, changes: Schema.Array(ValidatedChange) }, success: Result, error: CodingError
})

type Requirements = Action.Requirement<(typeof ValidatePlan | typeof Implement | typeof RunCheck | typeof FastGate | typeof Assess)["name"]>
type Stages = Node.Node<ReadonlyArray<ValidatedChange>, CodingError, Requirements>

/** Width is known from the plan. Slow checks never become a dependency of the next implementation. */
const stages = (plan: Plan, index: number, parent: Parameters<typeof Implement.call>[0]["parent"]): Stages => {
  const change = plan.changes[index]
  if (change === undefined) return Node.succeed([])
  return Node.bindPlanned(Implement.call({ change, parent, memoryRevision: plan.memoryRevision }), implementation => {
    const fast = Object.fromEntries(change.checks.filter(check => check.tier === "fast")
      .map(check => [check.id, RunCheck.call({ implementation, check })]))
    return Node.bindPlanned(Node.all(fast), receipts =>
      Node.bindPlanned(FastGate.call({ change, parent, implementation, receipts }), gated => {
        const slow = Object.fromEntries(change.checks.filter(check => check.tier === "slow")
          .map(check => [check.id, RunCheck.call({ implementation, check })]))
        return Node.all({
          current: Node.succeed(gated),
          review: Node.all(slow),
          next: stages(plan, index + 1, gated.implementation.head)
        }).pipe(Node.map(({ current, review, next }) => [
          { implementation: current.implementation, receipts: [...current.receipts, ...Object.values(review)] }, ...next
        ]))
      }))
  })
}

export const ImplementPlan = Flow.make("coding/ImplementPlan", {
  payload: { plan: Plan }, success: Result, error: CodingError,
  body: ({ plan }) => ValidatePlan.call({ plan }).pipe(Node.andThen(
    stages(plan, 0, plan.base).pipe(Node.bindPlanned(changes => Assess.call({ plan, changes })))
  ))
})

/** Policy-only implementations. No clock, database, lease, process, or second event log. */
export const policyLayers = Layer.mergeAll(
  ValidatePlan.toLayer(({ plan }) => Effect.try({ try: () => { validatePlan(plan); return plan }, catch: cause =>
    cause instanceof CodingError ? cause : new CodingError({ code: "invalid_plan", message: String(cause) }) })),
  FastGate.toLayer(({ change, parent, implementation, receipts }) => Effect.gen(function*() {
    if (implementation.change !== change.id || implementation.atoms.length !== change.atoms.length ||
        !sameRevision(implementation.atoms.at(-1)!, implementation.head) ||
        !sameRevision(implementation.parent, parent)) {
      return yield* Effect.fail(new CodingError({ code: "stale_revision", message: `Implementation does not match the planned atoms of ${change.id}` }))
    }
    let previous = parent
    const identities = new Set([parent.changeId])
    for (const [index, atom] of change.atoms.entries()) {
      const actual = implementation.atoms[index]!
      if (actual.parentCommitIds.length !== 1 || actual.parentCommitIds[0] !== previous.commitId || identities.has(actual.changeId)) {
        return yield* Effect.fail(new CodingError({ code: "stale_revision", message: `JJ atoms of ${change.id} do not form the planned linear progression` }))
      }
      identities.add(actual.changeId)
      previous = actual
      if (atom.changeId !== null && implementation.atoms[index]?.changeId !== atom.changeId) {
        return yield* Effect.fail(new CodingError({ code: "stale_revision", message: `Implementation replaced the native JJ identity of ${change.id}` }))
      }
    }
    for (const check of change.checks.filter(check => check.tier === "fast")) {
      const receipt = receipts[check.id]
      if (!receipt || !receiptMatches(implementation, check, receipt)) {
        return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: `Fast receipt ${check.id} does not identify the current revision` }))
      }
      if (check.required && receipt.status !== "passed") {
        return yield* Effect.fail(new CodingError({ code: "fast_gate", message: `${change.id}: ${check.target} did not pass on the current revision` }))
      }
    }
    return { implementation, receipts: Object.values(receipts) }
  })),
  Assess.toLayer(({ plan, changes }) => Effect.gen(function*() {
    const findings: Array<typeof Result.Type["findings"][number]> = []
    const identities = new Set([plan.base.changeId])
    if (changes.length !== plan.changes.length) return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: "The result is missing planned Changes" }))
    for (const [index, group] of plan.changes.entries()) {
      const result = changes[index]!
      if (result.implementation.change !== group.id) return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: "The result reordered the mythical progression" }))
      for (const atom of result.implementation.atoms) {
        if (identities.has(atom.changeId)) return yield* Effect.fail(new CodingError({ code: "stale_revision", message: `Native JJ change ${atom.changeId} has more than one implemented owner` }))
        identities.add(atom.changeId)
      }
      for (const check of group.checks.filter(check => check.tier !== "delivery")) {
        const receipt = result.receipts.find(receipt => receipt.checkId === check.id)
        if (!receipt || !receiptMatches(result.implementation, check, receipt)) {
          return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: `${group.id}: ${check.id} has no receipt for the implemented revision` }))
        }
        for (const finding of receipt.findings) {
          const owner = plan.changes.findIndex(change => change.id === finding.owner)
          if (owner < 0 || owner > index || finding.sourceCommitId !== result.implementation.head.commitId) {
            return yield* Effect.fail(new CodingError({ code: "invalid_receipt", message: `${check.id} supplied a finding with invalid owner or source revision` }))
          }
          findings.push(finding)
        }
        if (check.required && receipt.status !== "passed" && receipt.findings.length === 0) {
          findings.push({ owner: group.id, sourceCommitId: result.implementation.head.commitId, message: `${check.target}: ${receipt.status}` })
        }
      }
    }
    return { status: findings.length ? "changes-requested" as const : "validated" as const, changes, findings }
  }))
)
