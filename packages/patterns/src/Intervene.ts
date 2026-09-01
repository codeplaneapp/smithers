/**
 * Intervene pattern: read a target, propose a change, apply it behind an
 * optional approval, and report what happened.
 *
 * @see docs/pages/api/patterns-teams.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as WithApproval from "./WithApproval.ts"

const DEFAULT_REASON = "apply the proposed intervention"

/**
 * Configuration for {@link make}.
 *
 * `dryRun` removes the apply call from the declaration itself, so a dry-run
 * plan cannot reach a writing step. `approval` wraps apply with
 * {@link WithApproval.withApproval}, whose approval flow must produce the
 * literal `"approved"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly read: Flow.Any
  readonly propose: Flow.Any
  readonly apply: Flow.Any
  readonly report: Flow.Any
  readonly dryRun: boolean
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
   */
  readonly approval?: Flow.Any | undefined
  readonly reason?: string | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5> {
  readonly read: (input: I) => Effect.Effect<Context, E, R>
  readonly propose: (args: {
    readonly input: I
    readonly context: Context
  }) => Effect.Effect<Proposal, E2, R2>
  readonly apply: (args: {
    readonly input: I
    readonly proposal: Proposal
  }) => Effect.Effect<Applied, E3, R3>
  readonly report: (args: {
    readonly input: I
    readonly proposal: Proposal
    readonly applied: Applied | undefined
    readonly dryRun: boolean
  }) => Effect.Effect<Report, E4, R4>
  readonly dryRun: boolean
  readonly approval?:
    | ((args: {
      readonly input: I
      readonly proposal: Proposal
    }) => Effect.Effect<unknown, E5, R5>)
    | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const decide = Schema.decodeUnknownEffect(WithApproval.Approved)

/**
 * Builds the intervention topology: read, propose, then either report the
 * proposal alone (dry run) or apply it and report what was written.
 *
 * When `approval` is supplied, the apply flow is wrapped with
 * {@link WithApproval.withApproval}, so the built graph shows the approval call
 * ahead of apply. A denial cannot decode as `"approved"` and therefore fails on
 * the typed schema-error channel before apply starts.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const reason = options.reason ?? DEFAULT_REASON
  const apply = options.approval === undefined
    ? options.apply
    : WithApproval.withApproval(options.apply, { reason, approval: options.approval })
  const captures = { dryRun: options.dryRun, gated: options.approval !== undefined, reason }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [options.read, options.propose, apply, options.report],
    body: Node.capture(captures, (input) =>
      Node.andThen(
        call(options.read, { phase: "read", input }),
        Node.capture(captures, (context) =>
          Node.andThen(
            call(options.propose, { phase: "propose", input, context }),
            Node.capture(captures, (proposal) =>
              options.dryRun
                ? call(options.report, {
                  phase: "report",
                  input,
                  proposal,
                  applied: undefined,
                  dryRun: true
                })
                : Node.andThen(
                  call(apply, { phase: "apply", input, proposal }),
                  Node.capture(captures, (applied) =>
                    call(options.report, {
                      phase: "report",
                      input,
                      proposal,
                      applied,
                      dryRun: false
                    }))
                ))
          ))
      ))
  })
}

/**
 * Runs an intervention.
 *
 * A dry run reports the proposal and never calls `apply`. Otherwise the
 * approval decision, when one is configured, must decode as the literal
 * `"approved"`; a denial fails on the typed schema-error channel and `apply`
 * never runs.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5 = never, R5 = never>(
  input: I,
  options: RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5>
): Effect.Effect<Report, E | E2 | E3 | E4 | E5 | Schema.SchemaError, R | R2 | R3 | R4 | R5> =>
  Effect.gen(function*() {
    const context = yield* options.read(input)
    const proposal = yield* options.propose({ input, context })
    if (options.dryRun) {
      return yield* options.report({ input, proposal, applied: undefined, dryRun: true })
    }
    if (options.approval !== undefined) {
      yield* decide(yield* options.approval({ input, proposal }))
    }
    const applied = yield* options.apply({ input, proposal })
    return yield* options.report({ input, proposal, applied, dryRun: false })
  })
