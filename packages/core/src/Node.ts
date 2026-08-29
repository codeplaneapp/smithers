/**
 * Pipeable, pure-data nodes used to describe flow graphs.
 *
 * Constructing and combining nodes records an inspectable AST. Graph planning
 * evaluates pure `andThen` builders against symbolic values to reveal static
 * topology; it never executes a flow node, an Effect, or a value mapper.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Flow Builder Brief.md`,
 * `docs/specs/Concepts/Schema Shaped Builder.md`, and
 * `docs/specs/Concepts/Build Phases.md`.
 *
 * @since 0.0.0
 */
import type * as Context from "effect/Context"
import { dual } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import * as Annotations from "./Annotations.ts"
import type * as Effects from "./Effects.ts"
import * as internal from "./internal/node.ts"
import type * as Placement from "./Placement.ts"

/**
 * Runtime type identifier carried by every `Node`.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export const TypeId: TypeId = internal.TypeId

/**
 * Type-level representation of the `Node` runtime type identifier.
 *
 * @category type ids
 * @since 0.0.0
 * @slop
 */
export type TypeId = "~flows/core/Node"

/**
 * The inspectable AST stored by a `Node`.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Ast = internal.NodeAst

/**
 * A pure graph-building value with covariant success and error channels.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: Ast
}

/**
 * A type representing any `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Any = Node<unknown, unknown>

/**
 * Declares the inert values a plan-time function closes over.
 *
 * Capture data is canonicalized into deterministic function identity and
 * deeply frozen. Unannotated functions deliberately receive process-local
 * identity because JavaScript cannot inspect closure state. Unsupported values
 * are rejected instead of producing an incomplete cache identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const capture = <Args extends ReadonlyArray<unknown>, A>(
  captures: Readonly<Record<string, unknown>>,
  operation: (...args: Args) => A
): (...args: Args) => A => internal.capture(captures, operation)

/**
 * Extracts the success type of a `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Success<N> = N extends Node<infer A, infer _E> ? A : never

/**
 * Extracts the error type of a `Node`.
 *
 * @category utility types
 * @since 0.0.0
 * @slop
 */
export type Error<N> = N extends Node<infer _A, infer E> ? E : never

/**
 * Options recorded by a dynamic model node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface DynamicOptions {
  readonly model?: string | undefined
  readonly flows?: ReadonlyArray<unknown> | undefined
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
}

/**
 * Stable code emitted by node construction or continuation failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const NodeBuildErrorCode = Schema.Literals(["invalid_all_member", "invalid_continuation"])

/**
 * Stable code emitted by node construction or continuation failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type NodeBuildErrorCode = typeof NodeBuildErrorCode.Type

/**
 * A failure to construct or elaborate a valid node AST.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class NodeBuildError extends Schema.TaggedError<NodeBuildError>()("flows/core/NodeBuildError", {
  code: NodeBuildErrorCode,
  member: Schema.String,
  message: Schema.String
}) {}

/**
 * Checks whether an unknown value is a `Node`.
 *
 * @category guards
 * @since 0.0.0
 * @slop
 */
export const isNode = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * Constructs a node that succeeds with a constant value.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const succeed = <A>(value: A): Node<A> => internal.makeNode<A>(internal.succeed(value, Annotations.empty))

/**
 * Constructs a node that combines a record of independent child nodes.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const all = <const R extends Readonly<Record<string, Any>>>(
  nodes: R
): Node<
  Types.Simplify<{ readonly [K in keyof R]: Success<R[K]> }>,
  Error<R[keyof R]>
> => {
  const asts: Record<string, Ast> = {}
  for (const [member, node] of Object.entries(nodes)) {
    if (!isNode(node)) {
      throw new NodeBuildError({
        code: "invalid_all_member",
        member,
        message: `Node.all expected a Node at member "${member}"`
      })
    }
    asts[member] = node.ast
  }
  return internal.makeNode(internal.all(asts, Annotations.empty))
}

/**
 * Constructs an unelaborated dynamic model node with a typed output schema.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export function dynamic<A>(
  options: DynamicOptions & { readonly output?: { readonly Type: A } }
): Node<A>

/**
 * Constructs an unelaborated dynamic model node.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export function dynamic(options: DynamicOptions): Node<unknown>

export function dynamic(options: DynamicOptions): Node<unknown> {
  return internal.makeNode(internal.dynamic({
    ...options,
    flows: options.flows ?? []
  }, Annotations.empty))
}

/**
 * Maps the eventual success value of a node with a deferred pure function.
 *
 * @category mapping
 * @since 0.0.0
 * @slop
 */
export const map: {
  <A, B>(f: (a: A) => B): <E>(self: Node<A, E>) => Node<B, E>
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E>
} = dual(
  2,
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E> =>
    internal.makeNode<B, E>(
      internal.map(self.ast, (value) => f(value as A), f, Annotations.empty)
    )
)

/**
 * Sequences a pure node-producing builder after a node.
 *
 * A node value may be supplied directly when the first success value is not
 * needed by the next step. Graph planning evaluates the builder once against
 * a symbolic value so the downstream topology and its input references are
 * known before execution.
 *
 * @category sequencing
 * @since 0.0.0
 * @slop
 */
export const andThen: {
  <A, B, E2>(f: (a: A) => Node<B, E2>): <E>(self: Node<A, E>) => Node<B, E | E2>
  <B, E2>(next: Node<B, E2>): <A, E>(self: Node<A, E>) => Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, f: (a: A) => Node<B, E2>): Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, next: Node<B, E2>): Node<B, E | E2>
} = dual(
  2,
  <A, E, B, E2>(
    self: Node<A, E>,
    next: Node<B, E2> | ((a: A) => Node<B, E2>)
  ): Node<B, E | E2> =>
    internal.makeNode<B, E | E2>(
      typeof next === "function"
        ? internal.andThen(
          self.ast,
          (value) => next(value as A),
          next,
          Annotations.empty
        )
        : internal.andThenNode(self.ast, next.ast, Annotations.empty)
    )
)

const annotate = <A, E, I, S>(
  self: Node<A, E>,
  key: Context.Key<I, S>,
  value: S
): Node<A, E> =>
  internal.makeNode<A, E>(
    internal.withAnnotations(
      self.ast,
      Annotations.add(self.ast.annotations, key, value)
    )
  )

/**
 * Adds a placement annotation to a node without changing the original.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const within: {
  (placement: Placement.Placement): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, placement: Placement.Placement): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, placement: Placement.Placement): Node<A, E> =>
    annotate(self, Annotations.Placement, placement)
)

/**
 * Adds a worktree lane annotation to a node without changing the original.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const lane: {
  (options: Annotations.LaneOptions): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, options: Annotations.LaneOptions): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, options: Annotations.LaneOptions): Node<A, E> => annotate(self, Annotations.Lane, options)
)

/**
 * Adds an effect declaration annotation to a node without changing the
 * original.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const withEffects: {
  (declaration: Effects.Declaration): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, declaration: Effects.Declaration): Node<A, E>
} = dual(
  2,
  <A, E>(self: Node<A, E>, declaration: Effects.Declaration): Node<A, E> =>
    annotate(self, Annotations.Effects, declaration)
)
