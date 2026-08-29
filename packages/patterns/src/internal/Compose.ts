/**
 * The shared machinery every composition pattern is built from: reading a
 * flow's declaration, calling it as a node, and intersecting the effect
 * envelopes of the flows a pattern wraps.
 *
 * @since 0.1.0
 */
import { Effects, Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export interface FlowDetails extends Flow.Any {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export interface EffectIntersection {
  readonly declaration: Effects.Declaration | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly mode: boolean
  readonly tier: boolean
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const details = (flow: Flow.Any): FlowDetails => flow as FlowDetails

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const normalized = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort()

const intersectPaths = (
  template: ReadonlyArray<string>,
  supplied: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const intersection: Array<string> = []
  for (const expected of template) {
    for (const actual of supplied) {
      if (Effects.covers(expected, actual)) {
        intersection.push(actual)
      } else if (Effects.covers(actual, expected)) {
        intersection.push(expected)
      }
    }
  }
  return normalized(intersection)
}

const tierRank = {
  sealed: 0,
  compensable: 1,
  irreversible: 2
} as const

const tierOf = (declaration: Effects.Declaration): keyof typeof tierRank => declaration.tier ?? "sealed"

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const intersectEffects = (
  template: Effects.Declaration | undefined,
  supplied: Effects.Declaration | undefined
): EffectIntersection => {
  if (supplied === undefined) {
    return { declaration: undefined, reads: [], writes: [], mode: false, tier: false }
  }
  if (template === undefined) {
    return {
      declaration: undefined,
      reads: supplied.reads,
      writes: supplied.writes,
      mode: supplied.mode === "expected",
      tier: tierOf(supplied) !== "sealed"
    }
  }
  if (Effects.narrow(template, supplied).ok) {
    return { declaration: supplied, reads: [], writes: [], mode: false, tier: false }
  }
  const reads = intersectPaths(template.reads, supplied.reads)
  const writes = intersectPaths(template.writes, supplied.writes)
  const templateTier = tierOf(template)
  const suppliedTier = tierOf(supplied)
  const narrowedTier = tierRank[templateTier] <= tierRank[suppliedTier] ? templateTier : suppliedTier
  const declaration = Effects.make({
    reads,
    writes,
    mode: template.mode === "hermetic" || supplied.mode === "hermetic" ? "hermetic" : "expected",
    onConflict: template.onConflict,
    tier: narrowedTier
  })
  return {
    declaration,
    reads: supplied.reads.filter((path) => !reads.includes(path)),
    writes: supplied.writes.filter((path) => !writes.includes(path)),
    mode: supplied.mode !== declaration.mode,
    tier: suppliedTier !== narrowedTier
  }
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const intersectCapabilities = (
  template: ReadonlyArray<string>,
  supplied: ReadonlyArray<string>
): ReadonlyArray<string> => normalized(supplied.filter((capability) => template.includes(capability)))

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const redeclare = (
  template: Flow.Any,
  supplied: Flow.Any,
  name: string
): Flow.Any => {
  const expected = details(template)
  const actual = details(supplied)
  if (
    actual.effects !== undefined &&
    (expected.effects === undefined || !Effects.narrow(expected.effects, actual.effects).ok)
  ) {
    throw new PatternError({
      code: "envelope_conflict",
      message: `Decorator "${name}" widens the wrapped flow's declared effect envelope`
    })
  }
  return Flow.make({
    name,
    description: actual.description,
    input: expected.input,
    output: expected.output,
    capabilities: intersectCapabilities(expected.capabilities, actual.capabilities),
    effects: intersectEffects(expected.effects, actual.effects).declaration,
    flows: [supplied],
    body: Node.capture({ name }, (input) =>
      Node.andThen(
        Node.succeed({ _tag: "Decorator", name }),
        Node.capture({ name }, () => call(supplied, input))
      ))
  })
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const seal = (flow: Flow.Any): Flow.Any =>
  Flow.sealed(flow as unknown as Flow.Flow<Schema.Top, Schema.Top, unknown>)

const schemaDocument = (schema: Schema.Top): string | undefined => {
  try {
    return JSON.stringify(Schema.toJsonSchemaDocument(schema))
  } catch {
    return undefined
  }
}

const isTop = (schema: Schema.Top): boolean => schema.ast._tag === "Any" || schema.ast._tag === "Unknown"

const isNever = (schema: Schema.Top): boolean => schema.ast._tag === "Never"

const sameSchema = (left: Schema.Top, right: Schema.Top): boolean => {
  if (left === right) return true
  const leftDocument = schemaDocument(left)
  const rightDocument = schemaDocument(right)
  return leftDocument !== undefined && rightDocument !== undefined && leftDocument === rightDocument
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const schemasCompatible = (
  input: Schema.Top,
  output: Schema.Top,
  flow: Flow.Any
): boolean => {
  const flowAcceptsSlotInput = isNever(input) || isTop(flow.input) || (!isTop(input) && sameSchema(input, flow.input))
  const flowProducesSlotOutput = isTop(output) || isNever(flow.output) || sameSchema(output, flow.output)
  return flowAcceptsSlotInput && flowProducesSlotOutput
}

/**
 * @since 0.1.0
 * @slop
 * @private
 */
export const displayName = (flow: Flow.Any): string => details(flow).name ?? "anonymous"
