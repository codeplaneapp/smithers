/**
 * A deterministic panel deliberation pattern.
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * Panelists are held in a record so their declared keys are stable shard
 * identities. The moderator receives `{ input, opinions }`, where `opinions`
 * preserves those keys and declaration order.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly panelists: Readonly<Record<string, Flow.Any>>
  readonly moderator: Flow.Any
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Fans out every independent panelist call and then invokes the moderator.
 * `Node.all` gives child work structured-concurrency ownership: interruption
 * of the parent interrupts every outstanding panelist, and one panelist
 * failure fails the whole join.
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
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [...panelists.map(([, flow]) => flow), options.moderator],
    body: Node.capture({ panelists: panelists.map(([name]) => name) }, (input) => {
      const nodes: Record<string, Node.Any> = {}
      for (const [name, panelist] of panelists) nodes[name] = call(panelist, input)
      return Node.andThen(
        Node.all(nodes),
        Node.capture(
          { panelists: panelists.map(([name]) => name) },
          (opinions) => call(options.moderator, { input, opinions })
        )
      )
    })
  })
}
