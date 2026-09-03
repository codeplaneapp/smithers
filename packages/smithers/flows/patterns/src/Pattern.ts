/**
 * Flow-valued slots and authority-narrowing decorators.
 *
 * These combinators are a forward-compatible bridge for the future
 * `Schema.Flow` and `Flow.decorate` core surfaces.
 *
 * @see https://smithers.sh/api/patterns
 * @see https://smithers.sh/api/patterns#identity-and-ownership
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
 */
export interface Slot<I extends Schema.Top, O extends Schema.Top> {
  readonly input: I
  readonly output: O
  readonly default?: Flow.Any | undefined
}

type SchemaCompatibilityIssue = Exclude<ReturnType<typeof Compose.schemasCompatible>, undefined>

const schemaRefusalMessage = (subject: string, issue: SchemaCompatibilityIssue): string => {
  if (issue._tag === "SchemaConversionFailed") {
    return `${subject} ${issue.side} schemas cannot be compared because the ${issue.schema} ${issue.side} schema ` +
      `(${issue.tag}) has no JSON Schema form`
  }
  return issue.path === undefined
    ? `${subject} has an incompatible ${issue.side} schema: expected ${issue.expectedTag}, received ${issue.actualTag}`
    : `${subject} has an incompatible ${issue.side} schema: both schemas are ${issue.expectedTag} and they first ` +
      `differ at ${issue.path}`
}

/**
 * Declares a flow-valued slot.
 *
 * Defaults are checked immediately so an invalid declaration cannot enter a
 * plan. The returned slot is a frozen copy of the options, so a later edit to
 * the caller's object does not reach {@link bind}. Replace this bridge with
 * `Schema.Flow` when core provides it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const slot = <I extends Schema.Top, O extends Schema.Top>(
  options: Slot<I, O>
): Slot<I, O> => {
  const issue = options.default === undefined
    ? undefined
    : Compose.schemasCompatible(options.input, options.output, options.default)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The slot default", issue)
    })
  }
  // A frozen copy: `bind` reads the slot again later, and a caller's edit to
  // the options object in between must not turn a defaulted slot required or
  // swap in a default the check above never saw.
  return Object.freeze({ input: options.input, output: options.output, default: options.default })
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
  const issue = Compose.schemasCompatible(declaration.input, declaration.output, flow)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The bound flow", issue)
    })
  }
  return flow
}

/**
 * A transformation which wraps one flow with another flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Decorator = (inner: Flow.Any) => Flow.Any

/**
 * The portions of a supplied decorator declaration removed by its template
 * envelope.
 *
 * @category models
 * @since 0.1.0
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
  const issue = Compose.schemasCompatible(self.input, self.output, supplied)
  if (issue !== undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: schemaRefusalMessage("The flow decorator result", issue)
    })
  }
  const innerName = Compose.displayName(self)
  const suppliedName = Compose.details(supplied).name
  const decoratorName = decorator.name.length === 0 ? "decorate" : decorator.name
  // An unnamed decorator result carries the empty string, not `undefined`, so
  // it must not be adopted as the composed name: a flow called "" is worse than
  // the derived `decorate(anonymous)`.
  const name = suppliedName !== undefined && suppliedName.length > 0 && suppliedName !== innerName
    ? suppliedName
    : `${decoratorName}(${innerName})`
  return Compose.redeclare(self, supplied, name)
})

/**
 * Applies decorators from left to right, so the final decorator is outermost.
 *
 * @category combinators
 * @since 0.1.0
 */
export const decorateAll = (
  flow: Flow.Any,
  decorators: ReadonlyArray<Decorator>
): Flow.Any => decorators.reduce((inner, decorator) => decorate(inner, decorator), flow)
