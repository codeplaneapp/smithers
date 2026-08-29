/**
 * Flow-valued slots and authority-narrowing decorators.
 *
 * These combinators are a forward-compatible bridge for the future
 * `Schema.Flow` and `Flow.decorate` core surfaces.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import { Flow } from "@smthrs/core"
import { dual } from "effect/Function"
import type * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * A schema-constrained hole which may provide a default flow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Slot<I extends Schema.Top, O extends Schema.Top> {
  readonly input: I
  readonly output: O
  readonly default?: Flow.Any | undefined
}

/**
 * Declares a flow-valued slot.
 *
 * Defaults are checked immediately so an invalid declaration cannot enter a
 * plan. Replace this bridge with `Schema.Flow` when core provides it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const slot = <I extends Schema.Top, O extends Schema.Top>(
  options: Slot<I, O>
): Slot<I, O> => {
  if (options.default !== undefined && !Compose.schemasCompatible(options.input, options.output, options.default)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "The slot default does not satisfy its input and output schemas"
    })
  }
  return options
}

/**
 * Resolves a slot to a supplied flow or its default.
 *
 * The failure is raised during pure plan construction, matching core's typed
 * `FlowError` construction failures. Replace this bridge with flow-schema
 * decoding when core provides `Schema.Flow`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const bind = <I extends Schema.Top, O extends Schema.Top>(
  declaration: Slot<I, O>,
  supplied?: Flow.Any | undefined
): Flow.Any => {
  const flow = supplied ?? declaration.default
  if (flow === undefined) {
    throw new PatternError({
      code: "missing_slot",
      message: "A required flow slot was not bound and has no default"
    })
  }
  if (!Compose.schemasCompatible(declaration.input, declaration.output, flow)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "The bound flow does not satisfy the slot input and output schemas"
    })
  }
  return flow
}

/**
 * A transformation which wraps one flow with another flow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Decorator = (inner: Flow.Any) => Flow.Any

/**
 * The portions of a supplied decorator declaration removed by its template
 * envelope.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Clipped {
  readonly capabilities: ReadonlyArray<string>
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: boolean
  readonly tier: boolean
}

/**
 * Reports authority declared by `supplied` but excluded by `template`.
 *
 * @category introspection
 * @since 0.1.0
 * @slop
 */
export const clipped = (template: Flow.Any, supplied: Flow.Any): Clipped => {
  const expected = Compose.details(template)
  const actual = Compose.details(supplied)
  const effects = Compose.intersectEffects(expected.effects, actual.effects)
  const capabilities = actual.capabilities.filter(
    (capability) => !Compose.intersectCapabilities(expected.capabilities, actual.capabilities).includes(capability)
  )
  return {
    capabilities: [...new Set(capabilities)].sort(),
    reads: effects.reads,
    writes: effects.writes,
    mode: effects.mode,
    tier: effects.tier
  }
}

/**
 * Applies a decorator and re-declares the result under the wrapped flow's
 * schema and authority ceiling.
 *
 * The returned name derives from the decorator result (or the decorator
 * function name), and the extra flow call makes the decorator chain part of
 * declaration identity. Replace this bridge with `Flow.decorate` when core
 * provides it.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const decorate: {
  (decorator: Decorator): (self: Flow.Any) => Flow.Any
  (self: Flow.Any, decorator: Decorator): Flow.Any
} = dual(2, (self: Flow.Any, decorator: Decorator): Flow.Any => {
  const supplied = decorator(self)
  if (!Flow.isFlow(supplied)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "A flow decorator must return a Flow"
    })
  }
  if (!Compose.schemasCompatible(self.input, self.output, supplied)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "A flow decorator must preserve compatible input and output schemas"
    })
  }
  const innerName = Compose.displayName(self)
  const suppliedName = Compose.details(supplied).name
  const decoratorName = decorator.name.length === 0 ? "decorate" : decorator.name
  const name = suppliedName !== undefined && suppliedName !== innerName
    ? suppliedName
    : `${decoratorName}(${innerName})`
  return Compose.redeclare(self, supplied, name)
})

/**
 * Applies decorators from left to right, so the final decorator is outermost.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const decorateAll = (
  flow: Flow.Any,
  decorators: ReadonlyArray<Decorator>
): Flow.Any => decorators.reduce((inner, decorator) => decorate(inner, decorator), flow)
