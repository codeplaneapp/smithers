/**
 * Runbook pattern: an ordered list of steps where a step's risk decides
 * whether it is gated by an approval, and a denial either stops the runbook or
 * skips the step.
 *
 * @see docs/reference/patterns-teams.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"
import * as WithApproval from "./WithApproval.ts"

const DEFAULT_REASON = "run the step"

/**
 * How much authority a step needs before it runs.
 *
 * A `safe` step runs unasked. A `risky` step needs an approval. A `critical`
 * step needs an approval too, and its request carries `elevated: true`.
 *
 * @category models
 * @since 0.1.0
 */
export type Risk = "safe" | "risky" | "critical"

/**
 * What a denial does to the rest of the runbook.
 *
 * @category models
 * @since 0.1.0
 */
export type OnDeny = "fail" | "skip"

/**
 * One declared step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
  readonly id: string
  readonly flow: Flow.Any
  readonly risk: Risk
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly steps: ReadonlyArray<Step>
  readonly approval: Flow.Any
  readonly onDeny: OnDeny
  readonly reason?: string | undefined
}

/**
 * What an approval sees before a gated step runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request<I, Out> {
  readonly step: string
  readonly risk: Risk
  readonly elevated: boolean
  readonly input: I
  readonly previous: Out | undefined
}

/**
 * One step at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, Out, E, R> {
  readonly id: string
  readonly risk: Risk
  readonly run: (args: Request<I, Out>) => Effect.Effect<Out, E, R>
}

/**
 * Operational callbacks for {@link run}.
 *
 * `approve` must produce the literal `"approved"`; anything else is a denial
 * and fails the typed schema decode.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R, E2, R2> {
  readonly steps: ReadonlyArray<RuntimeStep<I, Out, E, R>>
  readonly approve: (request: Request<I, Out>) => Effect.Effect<unknown, E2, R2>
  readonly onDeny: OnDeny
}

/**
 * What a runbook did.
 *
 * `ran` and `skipped` are disjoint and together name every step. `outputs`
 * holds one entry per step in `ran`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out> {
  readonly outputs: Record<string, Out>
  readonly ran: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

type Approved = typeof WithApproval.Approved.Type

const decide = Schema.decodeUnknownEffect(WithApproval.Approved)

/**
 * Reports whether a step's risk requires an approval.
 *
 * @category introspection
 * @since 0.1.0
 */
export const gated = (risk: Risk): boolean => risk !== "safe"

/**
 * Reports whether a step's risk raises the approval request to elevated.
 *
 * @category introspection
 * @since 0.1.0
 */
export const elevated = (risk: Risk): boolean => risk === "critical"

const identities = (ids: ReadonlyArray<string>): boolean => new Set(ids).size === ids.length

/**
 * Builds the runbook topology: the steps chained in declaration order, with
 * every non-safe step wrapped by {@link WithApproval.withApproval}.
 *
 * Each step is called with `{ step, risk, elevated, input, previous }`, and the
 * approval that gates a step sees that same envelope, so a built graph shows
 * which step an approval belongs to and whether it is elevated.
 *
 * `onDeny` does not change the declared topology. A skip is a runtime decision
 * about a value the plan does not have, and the option is captured, so a
 * stopping runbook and a skipping runbook have different step identity.
 *
 * The declared flow stops at the first denial whatever `onDeny` says, because
 * `WithApproval` fails the wrapped step when the approval does not decode as
 * `"approved"` and the chain has no continuation past a failed step. Only
 * {@link run} skips a denied step and continues.
 *
 * `make` throws a `PatternError` when there are no steps, when two steps share
 * an id, or when the approval flow permits any value other than the literal
 * `"approved"`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (options.steps.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Runbook requires at least one step" })
  }
  const ids = options.steps.map((step) => step.id)
  if (!identities(ids)) {
    throw new PatternError({ code: "invalid_decorator", message: "Runbook step ids must be unique" })
  }
  const reason = options.reason ?? DEFAULT_REASON
  const captures = { steps: ids, risks: options.steps.map((step) => step.risk), onDeny: options.onDeny, reason }
  const declared = options.steps.map((step) =>
    gated(step.risk)
      ? {
        step,
        flow: WithApproval.withApproval(step.flow, {
          reason: `${reason}: ${step.id}`,
          approval: options.approval
        })
      }
      : { step, flow: step.flow }
  )
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: declared.map((entry) => entry.flow),
    body: Node.capture(captures, (input) => {
      const envelope = (index: number, previous: unknown): unknown => ({
        step: declared[index]!.step.id,
        risk: declared[index]!.step.risk,
        elevated: elevated(declared[index]!.step.risk),
        input,
        previous
      })
      const walk = (index: number, previous: unknown): Node.Node<unknown, unknown> => {
        const current = call(declared[index]!.flow, envelope(index, previous))
        if (index + 1 >= declared.length) return current
        return Node.andThen(
          current,
          Node.capture({ ...captures, step: declared[index + 1]!.step.id }, (value) => walk(index + 1, value))
        )
      }
      return walk(0, undefined)
    })
  })
}

/**
 * Runs a runbook.
 *
 * A safe step runs without asking. A non-safe step asks `approve` first, and
 * the answer must decode as the literal `"approved"`. Under `onDeny: "fail"` a
 * denial fails the runbook on the typed schema-error channel and no later step
 * runs. Under `onDeny: "skip"` the denied step is listed in `skipped`, the
 * runbook continues, and the next step sees the last step that actually ran as
 * its `previous`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Out, E = never, R = never, E2 = never, R2 = never>(
  input: I,
  options: RuntimeOptions<I, Out, E, R, E2, R2>
): Effect.Effect<Result<Out>, E | E2 | PatternError | Schema.SchemaError, R | R2> => {
  if (options.steps.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Runbook requires at least one step" }))
  }
  if (!identities(options.steps.map((step) => step.id))) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Runbook step ids must be unique" }))
  }
  return Effect.gen(function*() {
    const outputs: Record<string, Out> = {}
    const ran: Array<string> = []
    const skipped: Array<string> = []
    let previous: Out | undefined = undefined
    for (const step of options.steps) {
      const request: Request<I, Out> = {
        step: step.id,
        risk: step.risk,
        elevated: elevated(step.risk),
        input,
        previous
      }
      if (gated(step.risk)) {
        const answer = decide(yield* options.approve(request))
        const decision: Approved | "denied" = options.onDeny === "skip"
          ? yield* Effect.catch(answer, () => Effect.succeed("denied" as const))
          : yield* answer
        if (decision === "denied") {
          skipped.push(step.id)
          continue
        }
      }
      const output = yield* step.run(request)
      outputs[step.id] = output
      ran.push(step.id)
      previous = output
    }
    return { outputs, ran, skipped }
  })
}
