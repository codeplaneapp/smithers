/**
 * A deterministic panel deliberation pattern.
 *
 * A panel asks several flows the same question under different instructions
 * and hands one moderator every answer. {@link make} declares that topology,
 * {@link run} performs it.
 *
 * @see docs/pages/concepts/concurrency.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Bounded from "./Bounded.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * Panelists are held in a record so their declared keys are stable shard
 * identities. The moderator receives `{ input, opinions }`, where `opinions`
 * preserves those keys and declaration order.
 *
 * A panelist named in `roles` is called with `{ input, role }` instead of the
 * bare input, and the role is part of that call's identity. `concurrency`
 * bounds how many panelists the declaration lets run at once; without it the
 * panel fans out in one join.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly panelists: Readonly<Record<string, Flow.Any>>
  readonly moderator: Flow.Any
  readonly roles?: Readonly<Record<string, string>> | undefined
  readonly concurrency?: number | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeOptions<I, A, E, R, B, E2, R2> {
  readonly panelists: Readonly<Record<string, (input: I) => Effect.Effect<A, E, R>>>
  readonly moderator: (
    input: { readonly input: I; readonly opinions: Readonly<Record<string, A>> }
  ) => Effect.Effect<B, E2, R2>
  readonly concurrency?: number | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const payload = (input: unknown, role: string | undefined): unknown => role === undefined ? input : { input, role }

/**
 * Fans out every independent panelist call and then invokes the moderator.
 *
 * Without `concurrency`, `Node.all` gives child work structured-concurrency
 * ownership: interruption of the parent interrupts every outstanding
 * panelist, and one panelist failure fails the whole join. With
 * `concurrency`, the same members are batched by `Bounded.all`, so the plan
 * states how many panelists can be in flight.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const panelists = Object.entries(options.panelists)
  if (panelists.length === 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Panel requires at least one panelist"
    })
  }
  const roles = options.roles
  for (const name of Object.keys(roles ?? {})) {
    if (options.panelists[name] === undefined) {
      throw new PatternError({
        code: "invalid_decorator",
        message: `Panel declares a role for the unknown panelist "${name}"`
      })
    }
  }
  const names = panelists.map(([name]) => name)
  const material = {
    panelists: names,
    ...(roles === undefined ? {} : { roles: names.map((name) => roles[name] ?? null) }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [...panelists.map(([, flow]) => flow), options.moderator],
    body: Node.capture(material, (input) => {
      const nodes: Record<string, Node.Any> = {}
      for (const [name, panelist] of panelists) nodes[name] = call(panelist, payload(input, roles?.[name]))
      return Node.andThen(
        options.concurrency === undefined ? Node.all(nodes) : Bounded.all(nodes, { concurrency: options.concurrency }),
        Node.capture(
          { panelists: names },
          (opinions) => call(options.moderator, { input, opinions })
        )
      )
    })
  })
}

/**
 * Runs every panelist against the same input and hands the moderator one
 * record of opinions keyed by panelist name.
 *
 * `concurrency` bounds how many panelists run at once; without it they all
 * start together. Keys follow declaration order whatever order the panelists
 * settle in, so a moderator never sees a race in its payload.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const run = <I, A, E, R, B, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, B, E2, R2>
): Effect.Effect<B, E | E2 | PatternError, R | R2> =>
  Effect.suspend((): Effect.Effect<B, E | E2 | PatternError, R | R2> => {
    const panelists = Object.entries(options.panelists)
    if (panelists.length === 0) {
      return Effect.fail(
        new PatternError({ code: "invalid_decorator", message: "Panel requires at least one panelist" })
      )
    }
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    ) {
      return Effect.fail(
        new PatternError({
          code: "invalid_decorator",
          message: `Panel concurrency must be a positive safe integer, received ${options.concurrency}`
        })
      )
    }
    return Effect.flatMap(
      Effect.forEach(
        panelists,
        ([name, panelist]) => Effect.map(panelist(input), (opinion) => [name, opinion] as const),
        { concurrency: options.concurrency ?? "unbounded" }
      ),
      (opinions) => options.moderator({ input, opinions: Object.fromEntries(opinions) })
    )
  })
