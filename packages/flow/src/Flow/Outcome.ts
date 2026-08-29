/**
 * Serializable values with which one flow round can settle.
 *
 * Engine handoff semantics are intentionally separate. These values contain
 * only the completed value, the next flow invocation, or the durable waiting
 * classification described by `docs/specs/Concepts/Trampoline Loops.md`.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import type { WaitingAnnotation } from "../FlowRuntime/WaitingAnnotation.ts"

/**
 * A completed trampoline lineage value.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Done<A> {
  readonly _tag: "Done"
  /**
   * The completed value in its author-facing form. The engine encodes it with
   * the settling flow's success schema at the settlement boundary; callers do
   * not pre-encode values passed to {@link done}.
   */
  readonly value: A
}

/**
 * A serializable invocation of the next flow round.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface To<Payload> {
  readonly _tag: "To"
  readonly flow: string
  /**
   * The next round's payload in its author-facing form. The engine encodes it
   * with the target flow's payload schema at settlement, before persisting the
   * handoff; callers do not pre-encode values passed to `Flow.to`.
   */
  readonly payload: Payload
}

/**
 * A request to durably park the current flow round.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Park {
  readonly _tag: "Park"
  readonly reason: WaitingAnnotation
}

/**
 * The three pure-data settlements a trampoline round can produce.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Outcome<A = unknown, Payload = unknown> = Done<A> | To<Payload> | Park

/**
 * Schema for completed trampoline lineage values.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Done = Schema.Struct({
  _tag: Schema.tag("Done"),
  value: Schema.Unknown
})

/**
 * Schema for next-round flow invocations.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const To = Schema.Struct({
  _tag: Schema.tag("To"),
  flow: Schema.String,
  payload: Schema.Unknown
})

/**
 * Schema for durable trampoline parking requests.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Park = Schema.Struct({
  _tag: Schema.tag("Park"),
  reason: Schema.Struct({
    reason: Schema.String,
    wakeAt: Schema.optional(Schema.Number),
    token: Schema.optional(Schema.String)
  })
})

/**
 * Schema for every pure-data trampoline settlement.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Outcome = Schema.Union([Done, To, Park])

/**
 * Constructs a completed trampoline lineage value.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const done = <A>(value: A): Node.Node<Done<A>> => Node.succeed({ _tag: "Done", value })

/**
 * Constructs a durable parking request using the runtime waiting vocabulary.
 *
 * The two forms describe the same wait. The record is the whole waiting
 * vocabulary, and is what a park with a deadline needs; the positional form is
 * the common case — a reason and the token a wake handler matches against —
 * written the way an author says it out loud, `Flow.park("approval", requestId)`.
 * A positional call with no token omits the field rather than parking under an
 * empty one.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const park: {
  (reason: WaitingAnnotation): Node.Node<Park>
  (reason: string, token?: string | undefined): Node.Node<Park>
} = (reason: WaitingAnnotation | string, token?: string | undefined): Node.Node<Park> =>
  Node.succeed({
    _tag: "Park",
    reason: typeof reason !== "string"
      ? reason
      : token === undefined
      ? { reason }
      : { reason, token }
  })

/**
 * Whether a settled body value is one of the three trampoline settlements.
 *
 * A body's root node may settle with anything its author wrote; only these
 * three shapes ask the engine for a settlement other than "this value is the
 * answer", so this is the test the interpreter applies before it reaches for
 * `_tag`. The check is structural on purpose: an outcome is pure data that
 * crosses a plan, so it carries no brand to look for.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isOutcome: (value: unknown) => value is Outcome = Schema.is(Outcome)
