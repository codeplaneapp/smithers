/**
 * Sequential escalation pattern.
 *
 * A ladder tries strategies in order and stops at the first rung whose result
 * is good enough. Two deciders answer "good enough": the shared `accept` flow,
 * and a per-rung `escalateIf` that overrides it. A `fallback` runs only after
 * every rung escalated, which is where a human approval flow belongs.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 * @see docs/pages/concepts/failure-and-retry.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * One declared rung and the flow that decides whether it escalates.
 *
 * `escalateIf` receives `{ result, level }` and replaces the shared `accept`
 * flow for this rung alone. It escalates when it yields `true`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Rung {
  readonly flow: Flow.Any
  readonly escalateIf?: Flow.Any | undefined
}

/**
 * Configuration for {@link make}.
 *
 * Rungs are alternative strategies, not model-seat fallback. Provider or
 * seat fallback belongs to model routing before a flow is selected.
 *
 * `accept` decides every rung that declares no `escalateIf`. `fallback` is the
 * last rung: it runs only after every declared rung escalated.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly rungs: ReadonlyArray<Flow.Any | Rung>
  readonly accept?: Flow.Any | undefined
  readonly fallback?: Flow.Any | undefined
}

/**
 * One operational rung and its optional escalation predicate.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeRung<I, A, E, R, E2, R2> {
  readonly run: (input: I) => Effect.Effect<A, E, R>
  readonly escalateIf?: ((result: A, level: number) => Effect.Effect<boolean, E2, R2>) | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * A rung is either a plain effectful function or a {@link RuntimeRung} that
 * carries its own `escalateIf`. With no `accept` and no `escalateIf`,
 * {@link defaultEscalate} decides.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeOptions<I, A, E, R, E2, R2, F = A, E3 = never, R3 = never> {
  readonly rungs: ReadonlyArray<((input: I) => Effect.Effect<A, E, R>) | RuntimeRung<I, A, E, R, E2, R2>>
  readonly accept?: ((result: A) => Effect.Effect<unknown, E2, R2>) | undefined
  readonly fallback?: ((input: I) => Effect.Effect<F, E3, R3>) | undefined
}

/**
 * The rung that produced the settled result, and the result itself.
 *
 * `level` is the rung's index. A `fallback` result carries the rung count,
 * one past the last declared rung.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Reached<A> {
  readonly level: number
  readonly result: A
}

/**
 * The last rung's result, returned when every rung escalated and no fallback
 * was declared.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Exhausted<A> extends Reached<A> {
  readonly accepted: false
  readonly exhausted: true
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const accepted = (value: unknown): boolean =>
  value === true ||
  value === "approved" ||
  (
    typeof value === "object" &&
    value !== null &&
    "accepted" in value &&
    value.accepted === true
  )

/**
 * Decides escalation for a rung that names no predicate and no `accept` flow.
 *
 * A missing result escalates. So does a result that reports a failure the way
 * flows conventionally do: a set `error`, `failed: true`, or `ok: false`.
 * Anything else settles the ladder.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const defaultEscalate = (result: unknown): boolean => {
  if (result === undefined || result === null) return true
  if (typeof result !== "object") return false
  const row = result as Readonly<Record<string, unknown>>
  if ("error" in row && row.error !== undefined && row.error !== null && row.error !== false) return true
  if (row.failed === true) return true
  return row.ok === false
}

const declared = (rung: Flow.Any | Rung): Rung => "flow" in rung ? rung : { flow: rung }

const operational = <I, A, E, R, E2, R2>(
  rung: ((input: I) => Effect.Effect<A, E, R>) | RuntimeRung<I, A, E, R, E2, R2>
): RuntimeRung<I, A, E, R, E2, R2> => typeof rung === "function" ? { run: rung } : rung

/**
 * Builds the conservative bounded ladder topology, including every rung, every
 * decider, and the fallback. Use {@link run} for runtime acceptance and
 * short-circuiting.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (options.rungs.length === 0) {
    throw new PatternError({ code: "exhausted", message: "Escalation requires at least one rung" })
  }
  const rungs = options.rungs.map(declared)
  const flows = [
    ...rungs.flatMap((rung) => rung.escalateIf === undefined ? [rung.flow] : [rung.flow, rung.escalateIf]),
    ...(options.accept === undefined ? [] : [options.accept]),
    ...(options.fallback === undefined ? [] : [options.fallback])
  ]
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows,
    body: Node.capture({ rungs: rungs.length, fallback: options.fallback !== undefined }, (input) => {
      const exhausted = (last: unknown, level: number): Node.Node<unknown, unknown> =>
        options.fallback === undefined
          ? Node.succeed({ level, result: last, accepted: false, exhausted: true })
          : Node.andThen(
            call(options.fallback, input),
            Node.capture({ level: rungs.length }, (result) => Node.succeed({ level: rungs.length, result }))
          )
      const visit = (index: number, last: unknown): Node.Node<unknown, unknown> => {
        const rung = rungs[index]
        if (rung === undefined) return exhausted(last, index - 1)
        return Node.andThen(
          call(rung.flow, input),
          Node.capture({ rung: index }, (result) => {
            const settle = Node.succeed({ level: index, result })
            if (rung.escalateIf !== undefined) {
              return Node.andThen(
                call(rung.escalateIf, { result, level: index }),
                Node.capture(
                  { rung: index },
                  (decision) => decision === false ? settle : visit(index + 1, result)
                )
              )
            }
            if (options.accept === undefined) return visit(index + 1, result)
            return Node.andThen(
              call(options.accept, result),
              Node.capture({ rung: index }, (decision) => accepted(decision) ? settle : visit(index + 1, result))
            )
          })
        )
      }
      return visit(0, undefined)
    })
  })
}

const escalates = <I, A, E, R, E2, R2, F, E3, R3>(
  rung: RuntimeRung<I, A, E, R, E2, R2>,
  options: RuntimeOptions<I, A, E, R, E2, R2, F, E3, R3>,
  result: A,
  level: number
): Effect.Effect<boolean, E2, R2> => {
  if (rung.escalateIf !== undefined) return rung.escalateIf(result, level)
  if (options.accept !== undefined) return Effect.map(options.accept(result), (decision) => !accepted(decision))
  return Effect.succeed(defaultEscalate(result))
}

/**
 * Executes an escalation ladder and stops at the first rung that does not
 * escalate.
 *
 * This is the operational boundary for value-dependent branching. Core graph
 * planning intentionally evaluates `Node.andThen` builders with symbolic
 * values, so the flow declaration remains a conservative topology while this
 * Effect performs the runtime branch. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const run = <I, A, E, R, E2 = never, R2 = never, F = A, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2, F, E3, R3>
): Effect.Effect<Reached<A> | Reached<F> | Exhausted<A>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  if (options.rungs.length === 0) {
    return Effect.fail(new PatternError({ code: "exhausted", message: "Escalation requires at least one rung" }))
  }
  return Effect.gen(function*() {
    let last: A | undefined
    let level = 0
    for (const declaration of options.rungs) {
      const rung = operational(declaration)
      const result = yield* rung.run(input)
      last = result
      if (!(yield* escalates(rung, options, result, level))) return { level, result }
      level = level + 1
    }
    if (options.fallback !== undefined) {
      return { level: options.rungs.length, result: yield* options.fallback(input) }
    }
    return { level: options.rungs.length - 1, result: last as A, accepted: false, exhausted: true }
  })
}
