/**
 * Bounded retry helpers.
 *
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Compose from "./internal/Compose.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Retry declaration options.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options<Attempts extends number = number> {
  readonly attempts: Attempts
}

const declaration = <const Attempts extends number>(
  inner: Flow.Any,
  options: Options<Attempts>
): Flow.Any => {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry attempts must be a positive safe integer, received ${options.attempts}`
    })
  }
  const details = Compose.details(inner)
  return Flow.make({
    name: `withRetry(${Compose.displayName(inner)}, attempts=${options.attempts})`,
    description: details.description,
    input: details.input,
    output: details.output,
    capabilities: details.capabilities,
    effects: details.effects,
    flows: [inner],
    body: Node.capture({ attempts: options.attempts }, (input) => Compose.call(inner, input))
  })
}

/**
 * Builds a bounded retry decorator.
 *
 * The returned declaration preserves the wrapped flow's graph. Use
 * {@link retryEffect} at the Effect execution boundary; retry cannot be
 * truthfully encoded as a success-only `Node.andThen` chain.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = <const Attempts extends number>(options: Options<Attempts>): Pattern.Decorator => (inner) =>
  declaration(inner, options)

/**
 * Wraps a flow in a declaration-identifiable retry decorator.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const withRetry = <const Attempts extends number>(
  inner: Flow.Any,
  options: Options<Attempts>
): Flow.Any => Pattern.decorate(inner, make(options))

/**
 * Retries typed Effect failures up to the declared total attempt count.
 *
 * Effect schedules never recover fiber interruption, so cancellation
 * propagates without consuming or elaborating another attempt.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const retryEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: Options
): Effect.Effect<A, E, R> => {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry attempts must be a positive safe integer, received ${options.attempts}`
    })
  }
  return options.attempts === 1
    ? effect
    : Effect.retry(effect, Schedule.recurs(options.attempts - 1))
}
