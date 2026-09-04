/**
 * Pure, synchronous execution support for tests of node-building libraries.
 *
 * Production hosts execute compiled plans through the durable engine. A
 * higher-order builder still needs to test the deferred maps, continuations,
 * and recovery arms it records in a {@link Node.Node}. This module evaluates
 * that in-memory AST without capabilities, persistence, scheduling, or any
 * other host behavior. Dynamic nodes and flow calls cross one explicit
 * resolver boundary supplied by the test.
 *
 * @since 1.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import * as Flow from "./Flow.ts"
import * as internal from "./internal/node.ts"
import * as Node from "./Node.ts"

/**
 * Stable failure codes emitted by the test evaluator itself.
 *
 * @category models
 * @since 1.0.0
 */
export type EvaluationErrorCode =
  | "callback_threw"
  | "depth_exceeded"
  | "invalid_continuation"
  | "invalid_schema"
  | "missing_flow"
  | "missing_operation"
  | "resolver_threw"
  | "unresolved_node"

/**
 * A malformed or unresolved declaration encountered by the test evaluator.
 *
 * @category errors
 * @since 1.0.0
 */
export class EvaluationError extends Error {
  /** Stable machine-readable classification. */
  readonly code: EvaluationErrorCode
  /** The original thrown value, when one exists. */
  override readonly cause: unknown

  constructor(code: EvaluationErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "EvaluationError"
    this.code = code
    this.cause = cause
  }
}

/**
 * A dynamic-model request presented to a test resolver.
 *
 * @category models
 * @since 1.0.0
 */
export interface DynamicRequest {
  readonly _tag: "Dynamic"
  readonly model?: string | undefined
  readonly flows: ReadonlyArray<unknown>
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: unknown
}

/**
 * A declared flow call presented to a test resolver.
 *
 * @category models
 * @since 1.0.0
 */
export interface FlowCallRequest {
  readonly _tag: "FlowCall"
  readonly flow: unknown
  readonly target: unknown
  readonly input: unknown
}

/**
 * An execution leaf whose value the pure evaluator cannot invent.
 *
 * @category models
 * @since 1.0.0
 */
export type Request = DynamicRequest | FlowCallRequest

/**
 * Supplies deterministic values or typed failures for execution leaves.
 *
 * @category models
 * @since 1.0.0
 */
export type Resolver<E = never> = (request: Request) => Result.Result<unknown, E>

const maximumDepth = 1_024

const evaluatorFailure = (
  code: EvaluationErrorCode,
  message: string,
  cause?: unknown
): Result.Result<never, EvaluationError> => Result.fail(new EvaluationError(code, message, cause))

const invoke = (
  operation: (value: unknown) => unknown,
  value: unknown
): Result.Result<unknown, EvaluationError> => {
  try {
    return Result.succeed(operation(value))
  } catch (cause) {
    return evaluatorFailure("callback_threw", "A deferred node callback threw", cause)
  }
}

const resolve = <E>(resolver: Resolver<E>, request: Request): Result.Result<unknown, E | EvaluationError> => {
  try {
    return resolver(request)
  } catch (cause) {
    return evaluatorFailure("resolver_threw", `The test resolver threw while handling ${request._tag}`, cause)
  }
}

const evaluateAst = <E>(
  ast: internal.NodeAst,
  resolver: Resolver<E>,
  depth: number,
  inlineFlows: boolean
): Result.Result<unknown, unknown | E | EvaluationError> => {
  if (depth > maximumDepth) {
    return evaluatorFailure("depth_exceeded", `Node evaluation exceeds ${maximumDepth} nested declarations`)
  }
  switch (ast._tag) {
    case "Succeed":
      return Result.succeed(ast.value)
    case "Fail":
      return Result.fail(ast.error)
    case "All": {
      const pairs: Array<readonly [string, unknown]> = []
      for (const [name, child] of Object.entries(ast.nodes)) {
        const result = evaluateAst(child, resolver, depth + 1, inlineFlows)
        if (Result.isFailure(result)) return result
        pairs.push([name, result.success])
      }
      return Result.succeed(Object.fromEntries(pairs))
    }
    case "Dynamic":
      return resolve(resolver, {
        _tag: "Dynamic",
        model: ast.model,
        flows: ast.flows,
        output: ast.output,
        prompt: ast.prompt,
        effects: ast.effects
      })
    case "FlowCall": {
      const flow = internal.flow(ast)
      if (flow === undefined) {
        return evaluatorFailure("missing_flow", "A flow-call AST has lost its in-memory flow reference")
      }
      const implementation = Flow.isFlow(flow)
        ? (flow as Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown>).body
        : undefined
      if (inlineFlows && implementation !== undefined) {
        const invoked = invoke(implementation, ast.input)
        if (Result.isFailure(invoked)) return invoked
        if (!Node.isNode(invoked.success)) {
          return evaluatorFailure("invalid_continuation", "An inlined flow body did not return a Node")
        }
        return evaluateAst(invoked.success.ast, resolver, depth + 1, inlineFlows)
      }
      return resolve(resolver, { _tag: "FlowCall", flow, target: ast.target, input: ast.input })
    }
    case "Map": {
      const first = evaluateAst(ast.first, resolver, depth + 1, inlineFlows)
      if (Result.isFailure(first)) return first
      const operation = internal.operation(ast)
      return operation === undefined
        ? evaluatorFailure("missing_operation", "A map AST has lost its in-memory callback")
        : invoke(operation, first.success)
    }
    case "AndThen": {
      const first = evaluateAst(ast.first, resolver, depth + 1, inlineFlows)
      if (Result.isFailure(first)) return first
      let next: unknown
      if (ast.next !== undefined) {
        next = internal.makeNode(ast.next)
      } else {
        const operation = internal.operation(ast)
        if (operation === undefined) {
          return evaluatorFailure("missing_operation", "An andThen AST has lost its in-memory callback")
        }
        const invoked = invoke(operation, first.success)
        if (Result.isFailure(invoked)) return invoked
        next = invoked.success
      }
      if (!Node.isNode(next)) {
        return evaluatorFailure("invalid_continuation", "An andThen callback did not return a Node")
      }
      return evaluateAst(next.ast, resolver, depth + 1, inlineFlows)
    }
    case "Catch": {
      const first = evaluateAst(ast.first, resolver, depth + 1, inlineFlows)
      if (Result.isSuccess(first)) return first
      if (ast.error !== undefined) {
        if (!Schema.isSchema(ast.error)) {
          return evaluatorFailure("invalid_schema", "A catch AST carries an invalid error schema")
        }
        if (!SchemaParser.is(ast.error)(first.failure)) return first
      }
      const operation = internal.operation(ast)
      if (operation === undefined) {
        return evaluatorFailure("missing_operation", "A catch AST has lost its in-memory callback")
      }
      const handled = invoke(operation, first.failure)
      if (Result.isFailure(handled)) return handled
      if (!Node.isNode(handled.success)) {
        return evaluatorFailure("invalid_continuation", "A catch callback did not return a Node")
      }
      return evaluateAst(handled.success.ast, resolver, depth + 1, inlineFlows)
    }
  }
}

const unresolved: Resolver<EvaluationError> = (request) =>
  evaluatorFailure("unresolved_node", `No test value was supplied for ${request._tag}`)

/**
 * Evaluates a node's in-memory declaration with a deterministic leaf resolver.
 *
 * This is intentionally not a production runtime: it has no concurrency,
 * capability, journal, retry, cache, or schema-output semantics. It exists so
 * libraries that build nodes can execute the exact deferred callbacks they
 * installed and assert on their value behavior. A declaration nested more
 * than 1,024 levels is refused before unbounded recursion.
 *
 * @category testing
 * @since 1.0.0
 */
export const evaluate = <A, E, E2 = EvaluationError>(
  node: Node.Node<A, E>,
  resolver: Resolver<E2> = unresolved as Resolver<E2>
): Result.Result<A, E | E2 | EvaluationError> =>
  evaluateAst(node.ast, resolver, 0, false) as Result.Result<A, E | E2 | EvaluationError>

/**
 * Evaluates a node while recursively entering every called flow that carries
 * an in-memory body.
 *
 * Bodyless model or adapter flows still cross the supplied resolver. This is
 * useful for testing higher-order declarations whose implementation is itself
 * composed from smaller declared flows; it remains a pure test runtime and
 * does not model durable host behavior.
 *
 * @category testing
 * @since 1.0.0
 */
export const evaluateInline = <A, E, E2 = EvaluationError>(
  node: Node.Node<A, E>,
  resolver: Resolver<E2> = unresolved as Resolver<E2>
): Result.Result<A, E | E2 | EvaluationError> =>
  evaluateAst(node.ast, resolver, 0, true) as Result.Result<A, E | E2 | EvaluationError>
