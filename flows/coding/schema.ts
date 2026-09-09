/** Coding policy is ordinary flow input; the engine remains its durable store. */
import { Schema } from "effect"

const Text = Schema.NonEmptyString
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/))
export const Revision = Schema.Struct({
  changeId: Text,
  commitId: Text,
  treeId: Text,
  operationId: Text,
  parentCommitIds: Schema.Array(Text)
})
export type Revision = typeof Revision.Type

/** A project Change groups native JJ changes. Planned atoms have no second ID. */
export const AtomicPlan = Schema.Struct({
  changeId: Schema.NullOr(Text),
  message: Text,
  intent: Text,
  reads: Schema.Array(Text),
  writes: Schema.Array(Text)
})
export const Check = Schema.Struct({
  id: Id,
  target: Text,
  flow: Text,
  tier: Schema.Literals(["fast", "slow", "delivery"]),
  required: Schema.Boolean
})
export type Check = typeof Check.Type
export const Change = Schema.Struct({
  id: Id,
  title: Text,
  intent: Text,
  implementation: Text,
  atoms: Schema.Array(AtomicPlan).check(Schema.isMinLength(1)),
  checks: Schema.Array(Check)
})
export type Change = typeof Change.Type
export const Plan = Schema.Struct({
  prompt: Text,
  memoryRevision: Text,
  base: Revision,
  changes: Schema.Array(Change).check(Schema.isMinLength(1))
})
export type Plan = typeof Plan.Type
export const Finding = Schema.Struct({
  owner: Id,
  message: Text,
  sourceCommitId: Text
})
export type Finding = typeof Finding.Type
export const Implementation = Schema.Struct({
  change: Id,
  parent: Revision,
  atoms: Schema.Array(Revision).check(Schema.isMinLength(1)),
  head: Revision,
  reads: Schema.Array(Text),
  writes: Schema.Array(Text)
})
export type Implementation = typeof Implementation.Type
export const Receipt = Schema.Struct({
  checkId: Id,
  target: Text,
  tier: Schema.Literals(["fast", "slow", "delivery"]),
  change: Id,
  commitId: Text,
  treeId: Text,
  inputDigest: Text,
  status: Schema.Literals(["passed", "failed", "superseded"]),
  evidence: Schema.String,
  findings: Schema.Array(Finding)
})
export type Receipt = typeof Receipt.Type
export const ValidatedChange = Schema.Struct({
  implementation: Implementation,
  receipts: Schema.Array(Receipt)
})
export type ValidatedChange = typeof ValidatedChange.Type
export const Result = Schema.Struct({
  status: Schema.Literals(["validated", "changes-requested"]),
  changes: Schema.Array(ValidatedChange),
  findings: Schema.Array(Finding)
})
export type Result = typeof Result.Type
export class CodingError extends Schema.TaggedError<CodingError>()("coding/Error", {
  code: Schema.Literals(["invalid_plan", "fast_gate", "stale_revision", "invalid_receipt", "unavailable", "execution"]),
  message: Text
}) {}

/** Validate invariants before any implementation or check is scheduled. */
export const validatePlan = (plan: Plan): void => {
  const groups = new Set<string>(), nativeChanges = new Set<string>()
  for (const change of plan.changes) {
    if (groups.has(change.id)) throw new CodingError({ code: "invalid_plan", message: `Duplicate Change ${change.id}` })
    groups.add(change.id)
    const checks = new Set<string>()
    for (const check of change.checks) {
      if (checks.has(check.id)) throw new CodingError({ code: "invalid_plan", message: `Duplicate check ${check.id} in ${change.id}` })
      checks.add(check.id)
    }
    if (!change.checks.some(check => check.required && check.tier === "fast") ||
        !change.checks.some(check => check.required && check.tier === "slow")) {
      throw new CodingError({ code: "invalid_plan", message: `${change.id} needs a required fast check and a required slow check` })
    }
    for (const atom of change.atoms) {
      if (atom.changeId === null) continue
      if (nativeChanges.has(atom.changeId)) throw new CodingError({ code: "invalid_plan", message: `JJ change ${atom.changeId} has more than one owner` })
      nativeChanges.add(atom.changeId)
    }
  }
}

export const receiptMatches = (implementation: Implementation, check: Check, receipt: Receipt): boolean =>
  receipt.change === implementation.change && receipt.checkId === check.id && receipt.target === check.target &&
  receipt.tier === check.tier && receipt.commitId === implementation.head.commitId &&
  receipt.treeId === implementation.head.treeId
