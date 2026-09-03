/**
 * Failure-CATEGORY assertions for the test suite.
 *
 * `Exit.isFailure` is true for a typed failure and for a defect alike, so a
 * test that asserts only it cannot tell a refusal from a crash. That is not
 * hypothetical here: `BranchShare.makeNoop`'s `mint` used to `Effect.die`
 * where its declared type promises a `SyncError`, and `BranchRpcs` used to
 * accept a `displayName` the presence service then threw on — both stayed
 * green under `Exit.isFailure` alone. These helpers answer the question those
 * assertions could not: did it FAIL, with which error.
 *
 * @since 1.0.0-rc.0
 */
import { Cause, Exit } from "effect"

/**
 * The typed error one exit failed with, or `undefined` when it succeeded, when
 * it died, or when it was interrupted. A defect anywhere in the cause answers
 * `undefined`, so asserting on the result is asserting the failure was typed.
 */
export const refusalOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reasons = exit.cause.reasons
  if (!reasons.every(Cause.isFailReason)) return undefined
  return reasons.filter(Cause.isFailReason)[0]?.error
}

/** Whether one exit carries a defect rather than a typed failure. */
export const died = <A, E>(exit: Exit.Exit<A, E>): boolean =>
  Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)
