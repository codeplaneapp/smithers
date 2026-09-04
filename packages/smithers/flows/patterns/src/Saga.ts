/**
 * Forward steps with compensations that unwind in reverse.
 *
 * A saga is the answer to "the third call failed and the first two already
 * changed the world". Each step registers the call that undoes it, and a
 * failure walks those calls backwards, most recent first.
 *
 * @see https://smithers.sh/docs/concepts/retries
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * What a step failure does to the steps that already completed.
 *
 * Both {@link make} and {@link run} default to `compensate` when the caller
 * names no policy.
 *
 * `compensate` unwinds and returns a settled {@link Compensated} outcome.
 * `compensate-and-fail` unwinds and re-raises the original failure.
 * `fail` leaves the completed work alone.
 *
 * @category models
 * @since 0.1.0
 */
export type OnFailure = "compensate" | "compensate-and-fail" | "fail"

/**
 * One declared step: the call that changes the world, and the call that undoes
 * it.
 *
 * The action receives `{ input, completed }`, where `completed` holds the
 * values of the steps before it, keyed by id. The compensation receives
 * `{ id, input, value }`, where `value` is what its own action returned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
  readonly id: string
  readonly action: Flow.Any
  readonly compensation: Flow.Any
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly steps: ReadonlyArray<Step>
  readonly onFailure?: OnFailure | undefined
}

/**
 * One operational step.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, A, E, R, E2, R2> {
  readonly id: string
  readonly action: (
    input: { readonly input: I; readonly completed: Readonly<Record<string, A>> }
  ) => Effect.Effect<A, E, R>
  readonly compensation: (
    input: { readonly id: string; readonly input: I; readonly value: A }
  ) => Effect.Effect<unknown, E2, R2>
}

/**
 * Configuration for {@link run}.
 *
 * `run` snapshots `steps`, each step's `id`, `action`, and `compensation`,
 * and `onFailure` at the call, so a later edit to the array, a step record,
 * or the option object does not alter that run. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
  readonly steps: ReadonlyArray<RuntimeStep<I, A, E, R, E2, R2>>
  readonly onFailure?: OnFailure | undefined
}

/**
 * The settled outcome of a saga that unwound cleanly under `compensate`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Compensated<E> {
  readonly compensated: true
  readonly failure: E
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

// The refusal is minted once, as a value. `make` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
const stepsRefusal = (steps: ReadonlyArray<{ readonly id: string }>): PatternError | undefined => {
  if (steps.length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "Saga requires at least one step" })
  }
  const ids = new Set(steps.map((step) => step.id))
  if (ids.size !== steps.length) {
    return new PatternError({ code: "invalid_decorator", message: "Saga step ids must be unique" })
  }
  return undefined
}

// `make` builds topology out of the two flows a step names, so a value that is
// not a flow is refused here rather than left to fail inside `Graph.build` with
// a TypeError naming nothing a caller can act on. `run` takes effect functions
// instead and has nothing to check.
const declarationRefusal = (steps: ReadonlyArray<Step>): PatternError | undefined => {
  for (const step of steps) {
    if (!Flow.isFlow(step.action)) {
      return new PatternError({
        code: "invalid_decorator",
        message: `Saga step "${step.id}" action must be a flow`
      })
    }
    if (!Flow.isFlow(step.compensation)) {
      return new PatternError({
        code: "invalid_decorator",
        message: `Saga step "${step.id}" compensation must be a flow`
      })
    }
  }
  return undefined
}

/**
 * Declares the forward chain and its compensation arms.
 *
 * Each step's continuation is wrapped in a `Node.catch` whose arm calls that
 * step's compensation and re-raises, so a failure deeper in the chain unwinds
 * one step at a time, most recent first. Under `compensate`, the default, an
 * outer arm turns the re-raised failure into a settled {@link Compensated}
 * value; under `fail` no arm is declared at all.
 *
 * A step whose action or compensation is not a flow is refused here, because
 * the declaration cannot be built out of anything else.
 *
 * `make` snapshots `steps` and each step's `id`, `action`, and
 * `compensation` at the call, so a later edit to the caller's array or
 * records does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // this snapshot and never the caller's steps again.
  const steps: ReadonlyArray<Step> = options.steps.map((step) => ({
    id: step.id,
    action: step.action,
    compensation: step.compensation
  }))
  const refusal = stepsRefusal(steps) ?? declarationRefusal(steps)
  if (refusal !== undefined) throw refusal
  const policy = options.onFailure ?? "compensate"
  const flows = policy === "fail"
    ? steps.map((step) => step.action)
    : steps.flatMap((step) => [step.action, step.compensation])
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows,
    body: Node.capture({ steps: steps.map((step) => step.id), onFailure: policy }, (input) => {
      const visit = (index: number, completed: Readonly<Record<string, unknown>>): Node.Node<unknown, unknown> => {
        const step = steps[index]
        if (step === undefined) return Node.succeed(completed)
        return Node.andThen(
          call(step.action, { input, completed }),
          Node.capture({ step: step.id }, (value) => {
            const rest = visit(index + 1, { ...completed, [step.id]: value })
            if (policy === "fail") return rest
            return Node.catch(rest, {
              onFailure: Node.capture(
                { step: step.id },
                (error: unknown) =>
                  Node.andThen(
                    call(step.compensation, { id: step.id, input, value }),
                    Node.capture({ step: step.id }, () => Node.fail(error))
                  )
              )
            })
          })
        )
      }
      const chain = visit(0, {})
      if (policy !== "compensate") return chain
      return Node.catch(chain, {
        onFailure: Node.capture(
          { settled: true },
          (error: unknown) => Node.succeed({ compensated: true, failure: error })
        )
      })
    })
  })
}

/**
 * Runs the forward chain, unwinding completed steps on a failure or an
 * interruption.
 *
 * The policy defaults to `compensate`.
 *
 * Each completed step registers a scope finalizer, so the unwind is LIFO and
 * runs on interruption as well as on failure. A compensation that fails does
 * not stop the ones behind it; every failing step id is collected and the run
 * fails `PatternError { code: "compensation_failed" }` naming them, because
 * state left dirty outranks the failure that started the unwind.
 *
 * A compensation that DIES counts as a failed compensation, not as a defect
 * the run raises: the undo did not happen, so the step belongs in the residue
 * with the typed failures. Letting the defect escape would lose both the
 * residue and the failure that started the unwind.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2>
): Effect.Effect<Readonly<Record<string, A>> | Compensated<E>, E | PatternError, R | R2> => {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the array, a step record, or the option
  // object in between must not reach it.
  const steps: ReadonlyArray<RuntimeStep<I, A, E, R, E2, R2>> = options.steps.map((step) => ({
    id: step.id,
    action: step.action,
    compensation: step.compensation
  }))
  const policy = options.onFailure ?? "compensate"
  return Effect.suspend(() => {
    const refusal = stepsRefusal(steps)
    if (refusal !== undefined) return Effect.fail(refusal)
    const residue: Array<{ readonly id: string; readonly error: unknown }> = []
    const forward = Effect.gen(function*() {
      const completed = new Map<string, A>()
      for (const step of steps) {
        const value = yield* step.action({
          input,
          completed: Object.fromEntries(completed)
        })
        completed.set(step.id, value)
        if (policy === "fail") continue
        yield* Effect.addFinalizer((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.matchCause(step.compensation({ id: step.id, input, value }), {
              onFailure: (cause) => {
                residue.push({ id: step.id, error: Cause.squash(cause) })
              },
              onSuccess: () => {}
            })
        )
      }
      return Object.fromEntries(completed)
    })
    const settle = (
      exit: Exit.Exit<Readonly<Record<string, A>>, E>
    ): Effect.Effect<Readonly<Record<string, A>> | Compensated<E>, E | PatternError> => {
      const failure = Exit.findErrorOption(exit)
      if (residue.length > 0) {
        const sorted = [...residue].sort((left, right) => left.id.localeCompare(right.id))
        return Effect.fail(
          new PatternError({
            code: "compensation_failed",
            message: `Saga compensation failed for: ${sorted.map((entry) => entry.id).join(", ")}`,
            cause: {
              ...(Option.isSome(failure) ? { failure: failure.value } : {}),
              residue: sorted
            }
          })
        )
      }
      if (Exit.isSuccess(exit) || policy !== "compensate") return exit
      return Option.isSome(failure)
        ? Effect.succeed<Compensated<E>>({ compensated: true, failure: failure.value })
        : exit
    }
    return Effect.flatMap(Effect.exit(Effect.scoped(forward)), settle)
  })
}
