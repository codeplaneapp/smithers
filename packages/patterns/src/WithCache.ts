/**
 * Engine step-key cache decoration.
 *
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Compose from "./internal/Compose.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

const declaration = (inner: Flow.Any): Flow.Any => {
  const details = Compose.details(inner)
  const effects = details.effects
  if (
    effects === undefined ||
    effects.mode !== "hermetic" ||
    (effects.tier !== undefined && effects.tier !== "sealed")
  ) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "withCache requires an explicitly hermetic, sealed flow"
    })
  }
  return Flow.make({
    name: `withCache(${Compose.displayName(inner)})`,
    description: details.description,
    input: details.input,
    output: details.output,
    capabilities: details.capabilities,
    effects,
    flows: [inner],
    body: Node.capture({}, (input) => Compose.call(inner, input))
  })
}

/**
 * Builds a sealed step-key cache decorator.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (): Pattern.Decorator => (inner) => declaration(inner)

/**
 * Marks a sealable wrapper for engine step-key caching.
 *
 * Reuse remains an engine concern; this decorator allocates no map and keeps
 * no process-local state.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const withCache = (inner: Flow.Any): Flow.Any => Compose.seal(Pattern.decorate(inner, make()))
