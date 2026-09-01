/**
 * Trellis-style bounded recursive expansion declarations.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import type { Node as FlowNode } from "@smthrs/core/Node"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Parent-supplied recursion envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface Envelope {
  readonly fuel: number
  readonly depth: number
  readonly fanout: number
}

/**
 * Configuration accepted by {@link recurse}.
 *
 * `child` is the only collaborator. Bounds may be narrowed by nested calls;
 * they may never exceed the parent envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface RecurseOptions extends Envelope {
  readonly child: Flow.Any
  readonly parent?: Envelope | undefined
}

/**
 * A recursively expanded input branch.
 *
 * @category models
 * @since 0.1.0
 */
export interface Branch {
  readonly input: unknown
  readonly children?: ReadonlyArray<Branch> | undefined
}

const valid = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const boundError = (message: string): never => {
  throw new PatternError({ code: "recursion_bound", message })
}

/**
 * Validates and returns an envelope-bounded recursive tree flow.
 *
 * A plain input is a leaf. A `{ input, children }` branch expands recursively:
 * fuel is shared by the whole tree, depth is decremented per level, and every
 * child list is checked against fan-out before any child is admitted.
 * Very large depth and fan-out bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recurse = (options: RecurseOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (!valid(options.fuel) || !valid(options.depth) || !valid(options.fanout)) {
    return boundError("Recursion bounds must be positive safe integers")
  }
  const parent = options.parent
  if (
    parent !== undefined && (
      options.fuel > parent.fuel ||
      options.depth > parent.depth ||
      options.fanout > parent.fanout
    )
  ) {
    return boundError("Nested recursion may attenuate but cannot widen its parent envelope")
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [options.child],
    body: Node.capture({ depth: options.depth, fanout: options.fanout, fuel: options.fuel }, (input) => {
      if (typeof input === "function") {
        return boundError("Recursion input must be a literal tree available while planning")
      }
      const ledger = { remaining: options.fuel }
      const visit = (
        value: unknown,
        depth: number
      ): FlowNode<unknown, unknown> => {
        if (ledger.remaining < 1) return boundError("Recursion fuel is exhausted")
        const branch: Branch = typeof value === "object" && value !== null && "input" in value
          ? value
          : { input: value }
        const children = branch.children ?? []
        if (children.length > options.fanout) {
          return boundError("Recursive child fan-out exceeds the envelope")
        }
        if (children.length > 0 && depth <= 1) {
          return boundError("Recursive child depth exceeds the envelope")
        }
        ledger.remaining--
        const current = (options.child as unknown as (
          input: unknown
        ) => FlowNode<unknown, unknown>)({
          input: branch.input,
          envelope: {
            fuel: ledger.remaining,
            depth: depth - 1,
            fanout: options.fanout
          }
        })
        if (children.length === 0) return current
        return Node.andThen(
          current,
          Node.capture({ depth }, () => {
            const members: Record<string, FlowNode<unknown, unknown>> = {}
            children.forEach((child, index) => {
              members[`child-${index}`] = visit(child, depth - 1)
            })
            return Node.all(members)
          })
        )
      }
      return visit(input, options.depth)
    })
  })
}
