/**
 * Continue-on-failure fan-out.
 *
 * `Node.all` and `Effect.all` fail the join on the first member failure and
 * interrupt the rest, which is right when the members are one unit of work and
 * wrong when they are independent errands. {@link all} isolates a failing
 * member instead: its siblings run to completion and the join returns a record
 * of settled values and {@link Quarantined} markers.
 *
 * @see docs/pages/concepts/concurrency.md
 *
 * @since 0.1.0
 */
import { Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import { PatternError } from "./PatternError.ts"

/**
 * What a failing member does to its siblings.
 *
 * `quarantine` isolates it. `halt` is the ordinary join: the first failure
 * interrupts every sibling still running.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = "quarantine" | "halt"

/**
 * A member that failed and was isolated from its siblings.
 *
 * This is a structural tag on the wire so it survives durable JSON replay. A
 * successful member value with exactly this shape is indistinguishable from a
 * quarantined member; callers whose values can carry a `_tag` should wrap them.
 *
 * @category models
 * @since 0.1.0
 */
export interface Quarantined<E> {
  readonly _tag: "Quarantined"
  readonly member: string
  readonly error: E
}

/**
 * Configuration for {@link all}.
 *
 * @category models
 * @since 0.1.0
 */
export interface AllOptions {
  readonly policy: Policy
}

/**
 * Configuration for {@link run}.
 *
 * `concurrency` bounds how many members run at once and defaults to
 * unbounded.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions {
  readonly policy: Policy
  readonly concurrency?: number | "unbounded" | undefined
}

/**
 * Tests whether a joined member was quarantined.
 *
 * The check reads the full structural wire shape. A successful member value
 * with exactly that shape is indistinguishable, so callers whose values can
 * carry a `_tag` should wrap them.
 *
 * @category refinements
 * @since 0.1.0
 */
export const isQuarantined = (value: unknown): value is Quarantined<unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Quarantined" &&
  Object.hasOwn(value, "member") &&
  typeof (value as { readonly member: unknown }).member === "string" &&
  Object.hasOwn(value, "error")

// Every refusal is minted once, as a value. `all` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
const nonEmptyRefusal = (names: ReadonlyArray<string>): PatternError | undefined =>
  names.length === 0
    ? new PatternError({ code: "invalid_decorator", message: "Quarantine requires at least one member" })
    : undefined

const widthRefusal = (concurrency: number | "unbounded"): PatternError | undefined =>
  concurrency === "unbounded" || (Number.isSafeInteger(concurrency) && concurrency >= 1)
    ? undefined
    : new PatternError({
      code: "invalid_decorator",
      message: `Quarantine concurrency must be a positive safe integer, received ${concurrency}`
    })

const nonEmpty = (names: ReadonlyArray<string>): void => {
  const refusal = nonEmptyRefusal(names)
  if (refusal !== undefined) throw refusal
}

/**
 * Joins a record of members under the declared failure policy.
 *
 * Under `quarantine` each member gains a recovery arm that succeeds with a
 * {@link Quarantined} marker, so the declaration shows one `Catch` per member
 * and the join can no longer fail on a member's behalf. Under `halt` the join
 * is a plain `Node.all`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const all = (
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions
): Node.Node<Readonly<Record<string, unknown>>, unknown> => {
  const names = Object.keys(members)
  nonEmpty(names)
  if (options.policy === "halt") return Node.all(members)
  const isolated = Object.fromEntries(
    names.map((member) => [
      member,
      Node.catch(members[member]!, {
        onFailure: Node.capture(
          { member },
          (error: unknown) => Node.succeed({ _tag: "Quarantined", member, error })
        )
      })
    ])
  ) as Record<string, Node.Any>
  return Node.all(isolated)
}

/**
 * Runs a record of effects under the declared failure policy.
 *
 * Under `quarantine` every member runs to completion and a typed failure becomes
 * a {@link Quarantined} entry in the result; no sibling is interrupted on its
 * behalf. A defect and an interruption still propagate: quarantine isolates
 * declared failures, not a broken process. Under `halt` the first failure interrupts the members still in
 * flight and the whole join fails.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <A, E, R>(
  members: Readonly<Record<string, Effect.Effect<A, E, R>>>,
  options: RuntimeOptions
): Effect.Effect<Readonly<Record<string, A | Quarantined<E>>>, E | PatternError, R> =>
  Effect.suspend((): Effect.Effect<Readonly<Record<string, A | Quarantined<E>>>, E | PatternError, R> => {
    const names = Object.keys(members)
    const concurrency = options.concurrency ?? "unbounded"
    const refusal = nonEmptyRefusal(names) ?? widthRefusal(concurrency)
    if (refusal !== undefined) return Effect.fail(refusal)
    return Effect.map(
      Effect.forEach(
        names,
        (member) =>
          options.policy === "halt"
            ? Effect.map(members[member]!, (value) => [member, value] as const)
            : Effect.match(members[member]!, {
              onFailure: (error): readonly [string, A | Quarantined<E>] => [
                member,
                { _tag: "Quarantined", member, error }
              ],
              onSuccess: (value): readonly [string, A | Quarantined<E>] => [member, value]
            }),
        { concurrency }
      ),
      (pairs) => Object.fromEntries(pairs) as Readonly<Record<string, A | Quarantined<E>>>
    )
  })

/**
 * Turns a joined result into values, failing when any member was quarantined.
 *
 * Use it when the caller wants halt-after-join: every member got its chance to
 * run, and one failure still fails the step.
 *
 * The marker is a structural tag on the wire. A successful member value with
 * exactly that shape is indistinguishable, so callers whose values can carry a
 * `_tag` should wrap them before settling the record.
 *
 * @category combinators
 * @since 0.1.0
 */
export const settle = <A, E>(
  result: Readonly<Record<string, A | Quarantined<E>>>
): Effect.Effect<Readonly<Record<string, A>>, PatternError> => {
  const quarantined = Object.keys(result).filter((member) => isQuarantined(result[member])).sort()
  if (quarantined.length > 0) {
    return Effect.fail(
      new PatternError({
        code: "quarantined",
        message: `Quarantined members: ${quarantined.join(", ")}`,
        cause: quarantined.map((member) => {
          const entry = result[member] as Quarantined<E>
          return { member, error: entry.error }
        })
      })
    )
  }
  return Effect.succeed(result as Readonly<Record<string, A>>)
}
