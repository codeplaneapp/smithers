/**
 * Pure graph introspection for flow declarations.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
 *
 * @since 0.0.0
 */
import { Chunk, Context, Option, Result, Schema } from "effect"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import * as Flow from "./Flow.ts"
import * as EffectIndex from "./internal/effects.ts"
import * as internal from "./internal/node.ts"
import type { NodeAst } from "./internal/node.ts"
import type * as KeyMaterial from "./KeyMaterial.ts"
import * as Node from "./Node.ts"
import type * as Placement from "./Placement.ts"

interface FlowDetails extends Flow.Any {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: unknown) => Node.Node<unknown, unknown>) | undefined
  readonly implementation: Flow.Implementation | undefined
}

/**
 * Why one node depends on another.
 *
 * `value` is a structural dependency, `continuation` is a statically planned
 * `andThen` or `catch` arm, `conflict` is an ordering edge the write-conflict
 * pass added, and `lane-merge` joins two laned writers to their merge node.
 *
 * @category models
 * @since 0.1.0
 */
export type EdgeReason = "value" | "continuation" | "conflict" | "lane-merge"

interface InternalEdge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

interface InternalNode {
  id: string
  kind: NodeAst["_tag"] | "LaneMerge"
  dependencies: Array<string>
  declaredEffects: Effects.Declaration | undefined
  effectiveEffects: Effects.Declaration | undefined
  placement: Placement.Placement | undefined
  lane: Annotations.LaneOptions | undefined
  priority: number | undefined
  capabilities: ReadonlyArray<string>
  annotations: AnnotationsProjection
  keyMaterial: KeyMaterial.KeyMaterial | undefined
}

const noInput = Symbol("flows/core/Graph/noInput")
const PlannedValueTypeId = Symbol("flows/core/Graph/PlannedValue")

interface PlannedValueDescriptor {
  readonly from: string
  readonly path: ReadonlyArray<string>
}

interface VisitResult {
  readonly id: string
}

/**
 * A serializable projection of resolved annotations.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface AnnotationsProjection {
  readonly placement: Placement.Placement | undefined
  readonly effects: Effects.Declaration | undefined
  readonly lane: Annotations.LaneOptions | undefined
  readonly priority: number | undefined
}

/**
 * A node observed in a built graph.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface GraphNode {
  readonly id: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly dependencies: ReadonlyArray<string>
  readonly declaredEffects: Effects.Declaration | undefined
  readonly effectiveEffects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
  readonly lane: Annotations.LaneOptions | undefined
  readonly priority: number | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly annotations: AnnotationsProjection
  readonly keyMaterial: KeyMaterial.KeyMaterial
}

/**
 * A dependency edge in a built graph.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Edge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

/**
 * A pair of nodes whose declared writes overlap.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Conflict {
  readonly nodes: readonly [string, string]
  readonly paths: ReadonlyArray<string>
  readonly strategy: "serialize" | "lane" | "fail"
  readonly mergeNodeId?: string | undefined
}

/**
 * Declared and inherited effects for one graph node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface EffectEntry {
  readonly nodeId: string
  readonly declared: Effects.Declaration | undefined
  readonly effective: Effects.Declaration | undefined
}

/**
 * Resolved placement for one graph node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface PlacementEntry {
  readonly nodeId: string
  readonly placement: Placement.Placement
}

/**
 * Information supplied to the planner's pure per-node layer resolver.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface LayerRequest {
  readonly nodeId: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly model: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}

/**
 * Planner inputs used while constructing key material.
 *
 * `resolveLayers` is invoked independently for each node and must be pure. It
 * returns resolved host, model, and permission implementation identities, not
 * Effect Layers or runtime handles.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface BuildOptions {
  readonly resolveLayers?: ((request: LayerRequest) => Iterable<string>) | undefined
}

/**
 * Stable code emitted by graph-build diagnostics.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const GraphBuildErrorCode = Schema.Literals([
  "effect_outside_envelope",
  "effect_mode_widening",
  "effect_tier_widening",
  "missing_key_material",
  "write_conflict",
  "capability_outside_grant",
  "duplicate_node_id",
  "plan_too_deep",
  "plan_too_large",
  "payload_too_deep",
  "payload_too_large",
  "invalid_node"
])

/**
 * Stable code emitted by graph-build diagnostics.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type GraphBuildErrorCode = typeof GraphBuildErrorCode.Type

/**
 * A graph-build diagnostic. Declaration diagnostics are recorded so the graph
 * remains inspectable; malformed nodes and limit failures throw during
 * construction. Fatal diagnostics block {@link keyMaterial}, while
 * `capability_outside_grant` is advisory.
 *
 * `nodeId` is populated for the three effect-envelope codes,
 * `missing_key_material`, `duplicate_node_id`, `plan_too_deep`,
 * `plan_too_large`, `payload_too_deep`, `payload_too_large`,
 * `capability_outside_grant`, and `invalid_node`. For `plan_too_large` it
 * names the node whose admission crossed the limit: the node itself, the
 * target of the edge, the second writer of the conflict, or the node whose
 * effect declaration listed too many paths, too many patterns, or an
 * over-long path. `nodes` is populated for `write_conflict`. `paths` carries
 * the offending value path for `payload_too_large`.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("flows/core/GraphBuildError", {
  code: GraphBuildErrorCode,
  paths: Schema.Array(Schema.String),
  nodeId: Schema.optional(Schema.String),
  nodes: Schema.optional(Schema.Tuple([Schema.String, Schema.String]))
}) {}

const fatalGraphBuildErrorCodes: ReadonlySet<GraphBuildErrorCode> = Object.freeze(
  new Set<GraphBuildErrorCode>([
    "effect_outside_envelope",
    "effect_mode_widening",
    "effect_tier_widening",
    "write_conflict",
    "missing_key_material",
    "duplicate_node_id",
    "plan_too_deep",
    "plan_too_large",
    "payload_too_deep",
    "payload_too_large",
    "invalid_node"
  ])
)

/**
 * Reports whether a diagnostic blocks {@link keyMaterial}.
 *
 * A fatal diagnostic means the graph describes something the package cannot
 * turn into a step key. Every other code is advisory: it reports a narrowing a
 * reader should know about, and the graph still compiles. `invalid_node`,
 * `plan_too_deep`, `plan_too_large`, `payload_too_deep`, and
 * `payload_too_large` are thrown by {@link build} rather than recorded, so
 * they never reach this predicate in practice; they are listed as fatal so a
 * future caller that records one cannot compile it.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const isFatalDiagnostic = (diagnostic: GraphBuildError): boolean =>
  fatalGraphBuildErrorCodes.has(diagnostic.code)

/**
 * Maximum structural nesting accepted by {@link build}.
 *
 * @category limits
 * @since 0.1.0
 * @slop
 */
export const maximumGraphDepth = 512

/**
 * Maximum nesting accepted while projecting a plan value into identity.
 *
 * @category limits
 * @since 0.1.0
 * @slop
 */
export const maximumPayloadDepth = 128

/**
 * Maximum number of nodes, including synthesized lane merges, accepted by
 * {@link build}.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphNodes = 4096

/**
 * Maximum number of dependency edges, including the conflict and lane-merge
 * edges the write-conflict pass adds, accepted by {@link build}.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphEdges = 65_536

/**
 * Maximum number of write conflicts {@link build} records before it refuses
 * the plan.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphConflicts = 65_536

/**
 * Maximum number of members one plan value may expand to while it is
 * projected into identity: object keys, array items and holes, map entries,
 * set and chunk values, and bytes, summed across every level of that value.
 * A flow call's input and a declaration body are budgeted separately.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPayloadMembers = 100_000

/**
 * Maximum number of read and write paths, summed, one effect declaration may
 * list before {@link build} refuses the plan with `plan_too_large`. Every
 * declaration the graph carries obeys it: an annotation, a dynamic node's own
 * envelope, a called flow's envelope, and a synthesized lane merge, whose
 * reads and writes both name the overlap it merges.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectPaths = 1024

/**
 * Maximum number of effect paths {@link build} admits across one plan before
 * it refuses with `plan_too_large`. A declaration is counted where it is
 * declared and again at every work node that inherits it as its effective
 * envelope, because each such node is a writer the conflict pass compares.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPlanEffectPaths = 65_536

/**
 * Maximum length, in UTF-16 code units, of one effect path {@link build}
 * admits before it refuses the plan with `plan_too_large`. 4096 is `PATH_MAX`
 * on Linux, the longest path a supported host can open, so no path that names
 * a file is refused. Every per-character cost of a build is bounded by it:
 * the one dot-segment scan each path gets, the comparisons that sort the
 * distinct paths, and the comparisons that locate each pattern's prefix. The
 * length is read before any character is, so an over-long path costs one
 * property read.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectPathLength = 4096

/**
 * Maximum number of patterns, entries ending in `*`, one read list or one
 * write list of an effect declaration may carry before {@link build} refuses
 * the plan with `plan_too_large`. A pattern never costs a match more than a
 * literal path does: its prefix is located once by binary search, patterns
 * nested under another collapse into the outermost before the paths they
 * cover are enumerated, and every match after that is an integer comparison.
 * What a pattern costs beyond a literal is that search, two binary searches
 * of at most 16 comparisons each over a plan at {@link maximumPlanEffectPaths},
 * every comparison reading up to {@link maximumEffectPathLength} code units.
 * 128 keeps that term, 4,096 comparisons per list, below the sort that admits
 * a list of {@link maximumEffectPaths} literal paths, while still letting one
 * declaration name a subtree per package of a large monorepo. The count is
 * read from the last character of each path as it is admitted, so a pattern
 * past the limit costs one character read.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectGlobs = 128

interface GraphImpl {
  readonly nodes: ReadonlyArray<InternalNode>
  readonly edges: ReadonlyArray<InternalEdge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
  readonly conflicts: ReadonlyArray<Conflict>
}

/**
 * An immutable, observation-only flow graph.
 *
 * {@link build} deep-freezes everything it constructs, so the getters below
 * hand back the graph's own values rather than copies and an observer cannot
 * edit the plan it is reading. Read a graph through {@link nodes},
 * {@link edges}, {@link effects}, {@link placements}, {@link conflicts},
 * {@link diagnostics}, and {@link keyMaterial}; the storage fields behind those
 * getters are not part of the published shape.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Graph = GraphImpl

const option = <I, S>(context: Context.Context<never>, key: Context.Key<I, S>): S | undefined =>
  Option.getOrUndefined(Annotations.getOption(context, key))

const snapshotPlacement = (placement: Placement.Placement | undefined): Placement.Placement | undefined =>
  placement === undefined ? undefined : { ...placement }

const snapshotLane = (lane: Annotations.LaneOptions | undefined): Annotations.LaneOptions | undefined =>
  lane === undefined ? undefined : { ...lane }

const annotationProjection = (
  context: Context.Context<never>,
  effects: Effects.Declaration | undefined
): AnnotationsProjection => ({
  placement: snapshotPlacement(option(context, Annotations.Placement)),
  effects,
  lane: snapshotLane(option(context, Annotations.Lane)),
  priority: option(context, Annotations.Priority)
})

/**
 * Copies one declaration's paths, refusing before the copy grows past
 * `limit`. A real array is refused by its length before a member is read; any
 * other iterable is copied one path at a time and refused as soon as it
 * exceeds the limit, so a caller-assembled declaration cannot dodge the bound
 * by hiding its size from `length`. Each path is then refused by its length
 * before any character is read, and by the count of patterns the list has
 * carried so far, so an over-long path or a pattern past the limit costs one
 * property read.
 */
const copyPaths = (
  paths: ReadonlyArray<string>,
  limit: number,
  refuse: () => GraphBuildError
): Array<string> => {
  const copy: Array<string> = []
  let globs = 0
  const admit = (path: string): void => {
    if (path.length > maximumEffectPathLength) throw refuse()
    if (EffectIndex.isGlob(path) && ++globs > maximumEffectGlobs) throw refuse()
    copy.push(path)
  }
  if (Array.isArray(paths)) {
    const length = paths.length
    if (length > limit) throw refuse()
    for (let index = 0; index < length; index++) admit(paths[index])
    return copy
  }
  for (const path of paths) {
    if (copy.length >= limit) throw refuse()
    admit(path)
  }
  return copy
}

/**
 * Snapshots a declaration into graph-owned data, copying at most `limit`
 * paths in total across its reads and writes.
 */
const boundedEffects = (
  declaration: Effects.Declaration,
  limit: number,
  refuse: () => GraphBuildError
): Effects.Declaration => {
  const reads = copyPaths(declaration.reads, limit, refuse)
  const writes = copyPaths(declaration.writes, limit - reads.length, refuse)
  return {
    reads,
    writes,
    mode: declaration.mode,
    onConflict: declaration.onConflict,
    ...(declaration.tier === undefined ? {} : { tier: declaration.tier })
  }
}

const withoutEffects = (context: Context.Context<never>): Context.Context<never> =>
  Context.omit(Annotations.Effects)(context)

const tier = (effects: Effects.Declaration | undefined): KeyMaterial.KeyMaterial["kind"] => effects?.tier ?? "sealed"

const reflectionTags: ReadonlySet<string> = Object.freeze(
  new Set([
    "PlannedInput",
    "Undefined",
    "Number",
    "CyclicAnnotations",
    "BigInt",
    "Symbol",
    "Function",
    "Flow",
    "CircularFlow",
    "Circular",
    "Schema",
    "Accessor",
    "Array",
    "Hole",
    "Date",
    "RegExp",
    "Error",
    "Map",
    "Set",
    "Option",
    "Result",
    "Chunk",
    "URL",
    "Bytes",
    "Escaped"
  ])
)

const optionNonePrototype = Object.getPrototypeOf(Option.none())
const optionSomePrototype = Object.getPrototypeOf(Option.some(undefined))
const resultSuccessPrototype = Object.getPrototypeOf(Result.succeed(undefined))
const resultFailurePrototype = Object.getPrototypeOf(Result.fail(undefined))
const chunkPrototype = Object.getPrototypeOf(Chunk.empty())

const symbolIdentities = new WeakMap<object, string>() as unknown as {
  readonly get: (key: symbol) => string | undefined
  readonly set: (key: symbol, value: string) => unknown
}
let symbolOrdinal = 0

interface SymbolIdentity {
  readonly scope: "registered" | "well-known" | "process-local"
  readonly id: string
}

let wellKnownSymbolNames: ReadonlyMap<symbol, string> | undefined

const wellKnownSymbols = (): ReadonlyMap<symbol, string> => {
  if (wellKnownSymbolNames === undefined) {
    const names = new Map<symbol, string>()
    for (const key of Object.getOwnPropertyNames(Symbol)) {
      const descriptor = Object.getOwnPropertyDescriptor(Symbol, key)
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "symbol") {
        names.set(descriptor.value, key)
      }
    }
    wellKnownSymbolNames = names
  }
  return wellKnownSymbolNames
}

/**
 * Identifies a symbol as precisely as the host allows.
 *
 * A registered or well-known symbol has a name every process agrees on. An
 * unregistered symbol has no cross-process identity at all, so it receives the
 * same process-local treatment as an unannotated function: a nonce-seeded
 * ordinal that is stable within one process and deliberately different in the
 * next, reported through the encoding's `scope` field.
 */
const symbolIdentity = (value: symbol): SymbolIdentity => {
  const key = Symbol.keyFor(value)
  if (key !== undefined) return { scope: "registered", id: `global:${key}` }
  const wellKnown = wellKnownSymbols().get(value)
  if (wellKnown !== undefined) return { scope: "well-known", id: `well-known:${wellKnown}` }
  let id = symbolIdentities.get(value)
  if (id === undefined) {
    id = `${internal.processNonce()}:${symbolOrdinal++}`
    symbolIdentities.set(value, id)
  }
  return { scope: "process-local", id }
}

const payloadDepthError = (nodeId: string): GraphBuildError =>
  new GraphBuildError({ code: "payload_too_deep", paths: [], nodeId })

/**
 * Members already produced while projecting one plan value. One budget spans
 * every level of the value, so a wide object cannot dodge the limit by
 * spreading its members across many small containers.
 */
interface MemberBudget {
  used: number
}

const memberBudget = (): MemberBudget => ({ used: 0 })

/**
 * Accounts for the members a container is about to expand to. The charge is
 * taken before the members are materialized, so a sparse array with a huge
 * `length` is refused by its length rather than after its holes are built.
 */
const charge = (budget: MemberBudget, members: number, nodeId: string, path: string): void => {
  budget.used += members
  if (budget.used > maximumPayloadMembers) {
    throw new GraphBuildError({ code: "payload_too_large", paths: [path], nodeId })
  }
}

/**
 * Projects the effects a flow value carries into identity, charging each path
 * to the member budget so a flow placed inside a plan value cannot smuggle an
 * unbounded envelope past {@link maximumPayloadMembers}.
 */
const reflectedEffects = (
  declaration: Effects.Declaration | undefined,
  nodeId: string,
  path: string,
  budget: MemberBudget
): Effects.Declaration | undefined => {
  if (declaration === undefined) return undefined
  const effects = boundedEffects(
    declaration,
    maximumPayloadMembers - budget.used,
    () => new GraphBuildError({ code: "payload_too_large", paths: [path], nodeId })
  )
  charge(budget, effects.reads.length + effects.writes.length, nodeId, path)
  return effects
}

// The intrinsic getters read the collection's internal slot, so an own `size`
// property on a hostile subclass cannot understate the members about to be
// expanded.
const mapSize = (value: Map<unknown, unknown>): number =>
  Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!.call(value) as number

const setSize = (value: Set<unknown>): number =>
  Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!.call(value) as number

class CyclicAnnotationsSignal extends Error {}

const propertyPath = (path: string, key: string): string => `${path}.${key}`

const compareJsonText = (left: unknown, right: unknown): number => {
  const leftText = String(JSON.stringify(left))
  const rightText = String(JSON.stringify(right))
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

/**
 * Names a value for a refusal message.
 *
 * The immediate prototype is not enough: an `Option`, an `Either`, and most
 * other Effect data types carry no own `constructor`, so reading one level
 * reports `Unknown` for exactly the values authors are most likely to place in
 * a plan. The chain is walked first, then the structural labels those values do
 * carry.
 */
const constructorName = (value: object): string => {
  for (
    let current = Object.getPrototypeOf(value) as object | null;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    const constructor = Object.getOwnPropertyDescriptor(current, "constructor")
    if (constructor === undefined || !("value" in constructor) || typeof constructor.value !== "function") continue
    const name = Object.getOwnPropertyDescriptor(constructor.value, "name")
    if (name !== undefined && "value" in name && typeof name.value === "string" && name.value.length > 0) {
      return name.value
    }
  }
  for (const key of [Symbol.toStringTag, "_tag"]) {
    const label = dataProperty(value, key)
    if (typeof label === "string" && label.length > 0) return label
  }
  return "Unknown"
}

const unrepresentableInstance = (value: object, path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for a "${
      constructorName(value)
    }" instance at ${path}; plan values must be plain data`
  })

const nonFiniteNumber = (path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message:
      `Graph.build cannot derive identity for a number at ${path} because it is not finite; plan values must be plain data`
  })

const symbolKeyedProperty = (key: symbol, path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for the symbol-keyed property ${
      String(key)
    } at ${path}; plan values must use string keys`
  })

const dataProperty = (value: object, key: PropertyKey): unknown => {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

const regexpSource = (value: RegExp): string => {
  const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")
  return descriptor !== undefined && descriptor.get !== undefined
    ? descriptor.get.call(value) as string
    : ""
}

const regexpFlags = (value: RegExp): string => {
  const flags: ReadonlyArray<readonly [string, string]> = [
    ["d", "hasIndices"],
    ["g", "global"],
    ["i", "ignoreCase"],
    ["m", "multiline"],
    ["s", "dotAll"],
    ["u", "unicode"],
    ["v", "unicodeSets"],
    ["y", "sticky"]
  ]
  return flags.flatMap(([flag, property]) => {
    const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, property)
    return descriptor !== undefined && descriptor.get !== undefined && descriptor.get.call(value) ? [flag] : []
  }).join("")
}

const opaqueSchema = (path: string): Node.NodeBuildError =>
  new Node.NodeBuildError({
    code: "unrepresentable_value",
    member: path,
    message: `Graph.build cannot derive identity for the declared schema at ${path} because its guard is opaque; ` +
      "annotate it, for example with an identifier, so distinct declarations key differently"
  })

const emptyRecord = (value: unknown): boolean =>
  typeof value !== "object" || value === null || Reflect.ownKeys(value).length === 0

/**
 * Projects the type parameters a declared schema was built from, so
 * `Schema.Option(Schema.String)` and `Schema.Option(Schema.Number)` key
 * differently even though both render an opaque JSON Schema.
 */
const schemaTypeParameters = (
  ast: Schema.Top["ast"],
  nodeId: string,
  depth: number,
  path: string,
  budget: MemberBudget
): ReadonlyArray<unknown> => {
  const parameters = (ast as { readonly typeParameters?: unknown }).typeParameters
  if (!Array.isArray(parameters)) return []
  return parameters.map((parameter, index) =>
    schemaIdentity(
      Schema.make(parameter as Parameters<typeof Schema.make>[0]),
      nodeId,
      depth + 1,
      `${path}.typeParameters[${index}]`,
      budget
    )
  )
}

/**
 * Renders schema document, type-parameter, and structural annotation identity.
 *
 * An undecorated `Schema.declare` guard is inherently indistinguishable: the
 * guard is a closure the host cannot inspect, it takes no type parameters, and
 * JSON Schema renders it as the empty document, so every such schema would key
 * identically. That is refused rather than collapsed; annotating the
 * declaration, for example with an `identifier`, restores identity.
 */
function schemaIdentity(
  schema: Schema.Top,
  nodeId: string,
  depth: number,
  path: string,
  budget: MemberBudget = memberBudget()
): unknown {
  if (depth > maximumPayloadDepth) throw payloadDepthError(nodeId)
  // Read the AST exactly once: a schema is caller-supplied, so every extra read
  // is another chance for a hostile or lazily failing accessor to observe a
  // different value halfway through one projection.
  const source = schema.ast
  let annotations: unknown = null
  try {
    if (source.annotations !== undefined) {
      annotations = reflection(
        source.annotations,
        nodeId,
        new Set(),
        depth + 1,
        `${path}.ast.annotations`,
        true,
        budget
      )
    }
  } catch (cause) {
    if (cause instanceof CyclicAnnotationsSignal) {
      annotations = { _tag: "CyclicAnnotations" }
    } else {
      throw cause
    }
  }
  const typeParameters = schemaTypeParameters(source, nodeId, depth, path, budget)
  const ast = { tag: source._tag, annotations, typeParameters }
  let document: { readonly schema: unknown } | undefined
  try {
    document = Schema.toJsonSchemaDocument(schema)
  } catch {
    document = undefined
  }
  if (
    source._tag === "Declaration" &&
    typeParameters.length === 0 &&
    emptyRecord(annotations) &&
    (document === undefined || emptyRecord(document.schema))
  ) {
    throw opaqueSchema(path)
  }
  return document === undefined ? { _tag: "Schema", ast } : { _tag: "Schema", document, ast }
}

const plannedDescriptor = (value: unknown): PlannedValueDescriptor | undefined => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined
  return (value as { readonly [PlannedValueTypeId]?: PlannedValueDescriptor })[PlannedValueTypeId]
}

const plannedValue = (from: string, path: ReadonlyArray<string> = []): unknown => {
  const target = Function.prototype
  return new Proxy(target, {
    get: (_target, key) => {
      if (key === PlannedValueTypeId) return { from, path }
      if (key === Symbol.toPrimitive) return () => `[planned:${path.join(".")}]`
      if (key === "then") return undefined
      return plannedValue(from, [...path, String(key)])
    },
    apply: () => plannedValue(from, path)
  })
}

type PlannedInputRef = Extract<KeyMaterial.InputRef, { readonly _tag: "Ref" }>

const plannedInputRefs = (
  value: unknown,
  nodeId: string,
  seen: Set<object> = new Set(),
  depth = 0
): ReadonlyArray<PlannedInputRef> => {
  if (depth > maximumPayloadDepth) throw payloadDepthError(nodeId)
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return [{ _tag: "Ref", from: descriptor.from, path: descriptor.path }]
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return []
  if (seen.has(value)) return []
  seen.add(value)
  const refs: Array<PlannedInputRef> = []
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (let index = 0; index < value.length; index++) {
      const member = descriptors[String(index)]
      if (member !== undefined && member.enumerable && "value" in member) {
        refs.push(...plannedInputRefs(member.value, nodeId, seen, depth + 1))
      }
    }
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(descriptors).filter((key): key is string => typeof key === "string").sort()) {
      const member = descriptors[key]!
      if (member.enumerable && "value" in member) {
        refs.push(...plannedInputRefs(member.value, nodeId, seen, depth + 1))
      }
    }
  }
  seen.delete(value)
  return refs
}

const define = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

const isArrayIndex = (key: string, length: number): boolean => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length

/**
 * Projects one own property, describing an accessor instead of invoking it.
 */
const reflectedMember = (
  member: PropertyDescriptor,
  nodeId: string,
  seen: Set<object>,
  depth: number,
  path: string,
  rejectCycles: boolean,
  budget: MemberBudget
): unknown =>
  "value" in member
    ? reflection(member.value, nodeId, seen, depth + 1, path, rejectCycles, budget)
    : {
      _tag: "Accessor",
      get: member.get === undefined ? null : internal.functionIdentity(member.get),
      set: member.set === undefined ? null : internal.functionIdentity(member.set)
    }

/**
 * Projects plan values into canonical-JSON-compatible identity. Own
 * properties are read through descriptors; symbol-keyed properties are
 * refused because canonical JSON cannot represent their keys.
 */
function reflection(
  value: unknown,
  nodeId: string,
  seen: Set<object> = new Set(),
  depth = 0,
  path = "$",
  rejectCycles = false,
  budget: MemberBudget = memberBudget()
): unknown {
  if (depth > maximumPayloadDepth) throw payloadDepthError(nodeId)
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return {
      _tag: "PlannedInput",
      path: descriptor.path
    }
  }
  if (value === undefined) return depth > 0 ? { _tag: "Undefined" } : value
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { _tag: "Number", value: "-0" }
    if (!Number.isFinite(value)) throw nonFiniteNumber(path)
    return value
  }
  if (typeof value === "bigint") return { _tag: "BigInt", value: String(value) }
  if (typeof value === "symbol") {
    const identity = symbolIdentity(value)
    return {
      _tag: "Symbol",
      key: Symbol.keyFor(value) ?? null,
      description: value.description ?? null,
      scope: identity.scope,
      id: identity.id
    }
  }
  if (Flow.isFlow(value)) {
    if (seen.has(value)) {
      if (rejectCycles) throw new CyclicAnnotationsSignal()
      return { _tag: "CircularFlow" }
    }
    seen.add(value)
    const flow = value as FlowDetails
    const result = {
      _tag: "Flow",
      input: schemaIdentity(flow.input, nodeId, depth + 1, `${path}.input`, budget),
      output: schemaIdentity(flow.output, nodeId, depth + 1, `${path}.output`, budget),
      capabilities: [...new Set(flow.capabilities)].sort(),
      effects: reflectedEffects(flow.effects, nodeId, `${path}.effects`, budget),
      implementation: reflection(
        flow.implementation,
        nodeId,
        seen,
        depth + 1,
        `${path}.implementation`,
        rejectCycles,
        budget
      )
    }
    seen.delete(value)
    return result
  }
  if (Schema.isSchema(value)) return schemaIdentity(value, nodeId, depth, path, budget)
  if (typeof value === "function") return { _tag: "Function", identity: internal.functionIdentity(value) }
  if (seen.has(value)) {
    if (rejectCycles) throw new CyclicAnnotationsSignal()
    return { _tag: "Circular" }
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype === optionNonePrototype || prototype === optionSomePrototype) {
    seen.add(value)
    try {
      if (prototype === optionNonePrototype) return { _tag: "Option", value: { _tag: "None" } }
      const member = Object.getOwnPropertyDescriptor(value, "value")
      if (member === undefined || !("value" in member)) throw unrepresentableInstance(value, path)
      return {
        _tag: "Option",
        value: {
          _tag: "Some",
          value: reflection(member.value, nodeId, seen, depth + 1, `${path}.value`, rejectCycles, budget)
        }
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === resultSuccessPrototype || prototype === resultFailurePrototype) {
    seen.add(value)
    try {
      const key = prototype === resultSuccessPrototype ? "success" : "failure"
      const member = Object.getOwnPropertyDescriptor(value, key)
      if (member === undefined || !("value" in member)) throw unrepresentableInstance(value, path)
      return {
        _tag: "Result",
        value: prototype === resultSuccessPrototype
          ? {
            _tag: "Success",
            value: reflection(member.value, nodeId, seen, depth + 1, `${path}.success`, rejectCycles, budget)
          }
          : {
            _tag: "Failure",
            error: reflection(member.value, nodeId, seen, depth + 1, `${path}.failure`, rejectCycles, budget)
          }
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === chunkPrototype) {
    seen.add(value)
    try {
      charge(budget, Chunk.size(value as Chunk.Chunk<unknown>), nodeId, path)
      return {
        _tag: "Chunk",
        values: Chunk.toReadonlyArray(value as Chunk.Chunk<unknown>).map((member, index) =>
          reflection(member, nodeId, seen, depth + 1, `${path}.values[${index}]`, rejectCycles, budget)
        )
      }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype === URL.prototype) {
    return { _tag: "URL", href: URL.prototype.toString.call(value) }
  }
  if (value instanceof Date) {
    const epochMilliseconds = Date.prototype.getTime.call(value)
    return { _tag: "Date", epochMilliseconds: Number.isNaN(epochMilliseconds) ? null : epochMilliseconds }
  }
  if (value instanceof RegExp) {
    return { _tag: "RegExp", source: regexpSource(value), flags: regexpFlags(value) }
  }
  if (value instanceof Error) {
    const name = dataProperty(value, "name")
    const message = dataProperty(value, "message")
    return {
      _tag: "Error",
      name: typeof name === "string" ? name : "Error",
      message: typeof message === "string" ? message : ""
    }
  }
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer
  if (value instanceof ArrayBuffer || sharedArrayBuffer) {
    charge(budget, value.byteLength, nodeId, path)
    return {
      _tag: "Bytes",
      kind: constructorName(value),
      bytes: [...new Uint8Array(value)]
    }
  }
  if (ArrayBuffer.isView(value)) {
    charge(budget, value.byteLength, nodeId, path)
    return {
      _tag: "Bytes",
      kind: constructorName(value),
      bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
    }
  }
  seen.add(value)
  if (value instanceof Map) {
    try {
      charge(budget, mapSize(value), nodeId, path)
      const entries = [...Map.prototype.entries.call(value)].map(([key, member], index) => [
        reflection(key, nodeId, seen, depth + 1, `${path}.entries[${index}][0]`, rejectCycles, budget),
        reflection(member, nodeId, seen, depth + 1, `${path}.entries[${index}][1]`, rejectCycles, budget)
      ])
      entries.sort(compareJsonText)
      return { _tag: "Map", entries }
    } finally {
      seen.delete(value)
    }
  }
  if (value instanceof Set) {
    try {
      charge(budget, setSize(value), nodeId, path)
      const values = [...Set.prototype.values.call(value)].map((member, index) =>
        reflection(member, nodeId, seen, depth + 1, `${path}.values[${index}]`, rejectCycles, budget)
      )
      values.sort(compareJsonText)
      return { _tag: "Set", values }
    } finally {
      seen.delete(value)
    }
  }
  if (Array.isArray(value)) {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const symbol = Reflect.ownKeys(descriptors).find((key): key is symbol => typeof key === "symbol")
      if (symbol !== undefined) throw symbolKeyedProperty(symbol, path)
      const extraKeys = Reflect.ownKeys(descriptors)
        .filter((key): key is string => typeof key === "string" && key !== "length" && !isArrayIndex(key, value.length))
        .sort()
      charge(budget, value.length + extraKeys.length, nodeId, path)
      const items = new Array<unknown>(value.length)
      for (let index = 0; index < value.length; index++) {
        const member = descriptors[String(index)]
        define(
          items,
          String(index),
          member === undefined
            ? { _tag: "Hole" }
            : reflectedMember(member, nodeId, seen, depth, `${path}[${index}]`, rejectCycles, budget)
        )
      }
      if (extraKeys.length === 0) return items
      const extra = Object.create(null) as Record<string, unknown>
      for (const key of extraKeys) {
        define(
          extra,
          key,
          reflectedMember(descriptors[key]!, nodeId, seen, depth, propertyPath(path, key), rejectCycles, budget)
        )
      }
      return { _tag: "Array", items, extra }
    } finally {
      seen.delete(value)
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value)
    throw unrepresentableInstance(value, path)
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const symbol = Reflect.ownKeys(descriptors).find((key): key is symbol => typeof key === "symbol")
    if (symbol !== undefined) throw symbolKeyedProperty(symbol, path)
    const keys = Reflect.ownKeys(descriptors).filter((key): key is string => typeof key === "string").sort()
    charge(budget, keys.length, nodeId, path)
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      define(
        result,
        key,
        reflectedMember(descriptors[key]!, nodeId, seen, depth, propertyPath(path, key), rejectCycles, budget)
      )
    }
    const tag = descriptors._tag
    return tag !== undefined && "value" in tag && typeof tag.value === "string" && reflectionTags.has(tag.value)
      ? { _tag: "Escaped", value: result }
      : result
  } finally {
    seen.delete(value)
  }
}

const declarationBody = (
  ast: NodeAst,
  flow: FlowDetails | undefined,
  nodeId: string,
  ownEffects: Effects.Declaration | undefined
): unknown => {
  switch (ast._tag) {
    case "Succeed":
      return { _tag: ast._tag, value: reflection(ast.value, nodeId) }
    case "Fail":
      return { _tag: ast._tag, error: reflection(ast.error, nodeId) }
    case "All":
      return { _tag: ast._tag, keys: Object.keys(ast.nodes).sort() }
    case "Dynamic":
      return {
        _tag: ast._tag,
        model: ast.model,
        flows: reflection(ast.flows, nodeId, new Set(), 0, "$.flows"),
        output: reflection(ast.output, nodeId, new Set(), 0, "$.output"),
        prompt: ast.prompt,
        effects: ownEffects
      }
    case "FlowCall":
      return {
        _tag: ast._tag,
        input: flow === undefined ? undefined : schemaIdentity(flow.input, nodeId, 0, "$.input"),
        output: flow === undefined ? undefined : schemaIdentity(flow.output, nodeId, 0, "$.output"),
        capabilities: flow?.capabilities === undefined ? undefined : [...new Set(flow.capabilities)].sort(),
        effects: ownEffects,
        implementation: reflection(flow?.implementation, nodeId, new Set(), 0, "$.implementation")
      }
    case "Map":
      return { _tag: ast._tag, mapper: ast.mapper }
    case "AndThen":
      return { _tag: ast._tag, continuation: ast.continuation, static: ast.next !== undefined }
    case "Catch":
      return {
        _tag: ast._tag,
        handler: ast.handler,
        error: ast.error === undefined ? undefined : schemaIdentity(ast.error as Schema.Top, nodeId, 0, "$.error")
      }
  }
}

const strategy = (left: Effects.Declaration, right: Effects.Declaration): Conflict["strategy"] => {
  if (left.onConflict === "fail" || right.onConflict === "fail") return "fail"
  if (left.onConflict === "lane" || right.onConflict === "lane") return "lane"
  return "serialize"
}

const supportedNodeTags: ReadonlySet<NodeAst["_tag"]> = Object.freeze(
  new Set<NodeAst["_tag"]>([
    "Succeed",
    "Fail",
    "All",
    "Dynamic",
    "AndThen",
    "Map",
    "FlowCall",
    "Catch"
  ])
)

const invalidNode = (nodeId: string, cause?: unknown): GraphBuildError => {
  const error = new GraphBuildError({ code: "invalid_node", paths: [], nodeId })
  Object.defineProperty(error, "message", {
    configurable: true,
    enumerable: false,
    value: `Graph.build expected a supported Node AST at "${nodeId}"`,
    writable: true
  })
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: false
    })
  }
  return error
}

const validateNodeAst = (value: unknown, nodeId: string): NodeAst => {
  try {
    if (typeof value !== "object" || value === null) throw invalidNode(nodeId)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const tag = descriptors._tag
    const annotations = descriptors.annotations
    if (
      tag === undefined ||
      !("value" in tag) ||
      !supportedNodeTags.has(tag.value as NodeAst["_tag"]) ||
      annotations === undefined ||
      !("value" in annotations) ||
      !Context.isContext(annotations.value)
    ) {
      throw invalidNode(nodeId)
    }
    const field = (key: string): unknown => {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !("value" in descriptor)) throw invalidNode(nodeId)
      return descriptor.value
    }
    switch (tag.value as NodeAst["_tag"]) {
      case "Succeed":
        field("value")
        break
      case "Fail":
        field("error")
        break
      case "All": {
        const nodes = field("nodes")
        if (nodes === null || typeof nodes !== "object") throw invalidNode(nodeId)
        break
      }
      case "Dynamic":
        if (!Array.isArray(field("flows"))) throw invalidNode(nodeId)
        break
      case "AndThen":
      case "Map":
      case "Catch": {
        const first = field("first")
        if (first === null || typeof first !== "object") throw invalidNode(nodeId)
        if (tag.value === "Catch") {
          const error = field("error")
          if (error !== undefined && !Schema.isSchema(error)) throw invalidNode(nodeId)
        }
        break
      }
      case "FlowCall":
        field("input")
        break
    }
    return value as NodeAst
  } catch (cause) {
    if (cause instanceof GraphBuildError) throw cause
    throw invalidNode(nodeId, cause)
  }
}

const nodeAst = (value: unknown, nodeId: string): NodeAst => {
  try {
    return validateNodeAst((value as { readonly ast?: unknown } | null)?.ast, nodeId)
  } catch (cause) {
    if (cause instanceof GraphBuildError) throw cause
    throw invalidNode(nodeId, cause)
  }
}

const freezeDeep = (value: unknown, seen: WeakSet<object> = new WeakSet()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    // A graph-owned array holds only indexed data members, so they are read
    // in place: describing each would allocate one record per path of every
    // conflict's list and every diagnostic's list only to discard it.
    for (const member of value) freezeDeep(member, seen)
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) freezeDeep(descriptor.value, seen)
    }
  }
  Object.freeze(value)
}

const freezeKeyMaterial = (material: KeyMaterial.KeyMaterial): void => {
  freezeDeep(material.body)
  for (const input of material.inputs) {
    if (input._tag === "Ref") freezeDeep(input.path)
    // A Literal payload is this module's own projection of the plan value, not
    // the caller's object, so freezing it closes the last writable path into
    // recorded key material.
    if (input._tag === "Literal") freezeDeep(input.value)
    Object.freeze(input)
  }
  freezeDeep(material.inputs)
  freezeDeep(material.layers)
  freezeDeep(material.capabilities)
  freezeDeep(material.effects)
  freezeDeep(material.placement)
  Object.freeze(material)
}

const freezeGraph = (
  graph: {
    readonly nodes: Array<InternalNode>
    readonly edges: Array<InternalEdge>
    readonly diagnostics: Array<GraphBuildError>
    readonly conflicts: Array<Conflict>
  }
): Graph => {
  for (const node of graph.nodes) {
    freezeDeep(node.dependencies)
    freezeDeep(node.declaredEffects)
    freezeDeep(node.effectiveEffects)
    freezeDeep(node.placement)
    freezeDeep(node.lane)
    freezeDeep(node.capabilities)
    freezeDeep(node.annotations)
    /* v8 ignore else -- `build` gives every node key material before freezing; the guard keeps the field optional for readers that construct a graph by hand */
    if (node.keyMaterial !== undefined) freezeKeyMaterial(node.keyMaterial)
    Object.freeze(node)
  }
  for (const edge of graph.edges) freezeDeep(edge)
  for (const conflict of graph.conflicts) freezeDeep(conflict)
  for (const diagnostic of graph.diagnostics) freezeDeep(diagnostic)
  freezeDeep(graph.nodes)
  freezeDeep(graph.edges)
  freezeDeep(graph.conflicts)
  freezeDeep(graph.diagnostics)
  return Object.freeze(graph)
}

/**
 * Builds a graph by evaluating declared flow bodies and pure `Node.andThen`
 * builders exactly once against symbolic predecessor values. This reveals the
 * complete static topology without running a node, an Effect, a `Node.map`
 * value transformation, or a dynamic elaboration.
 *
 * Values supplied to `Node.succeed`, `Node.fail`, and flow calls are retained
 * by reference and read here. Mutating one before this function runs changes
 * its recorded identity.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const build = (
  flowOrNode: Flow.Any | Node.Any,
  input?: unknown,
  options: BuildOptions = {}
): Graph => {
  const observed: Array<InternalNode> = []
  const observedEdges: Array<InternalEdge> = []
  const observedDiagnostics: Array<GraphBuildError> = []
  const workNodes = new Set<InternalNode>()
  // Outgoing edges by source, each with its position in `observedEdges`, so a
  // reachability query and a lane-merge consumer lookup cost the node's degree
  // rather than a scan of every edge recorded so far.
  const outgoing = new Map<string, Array<{ readonly to: string; readonly index: number }>>()
  const edgesFrom = (id: string): ReadonlyArray<{ readonly to: string; readonly index: number }> =>
    outgoing.get(id) ?? []

  const planTooLarge = (nodeId: string): GraphBuildError =>
    new GraphBuildError({ code: "plan_too_large", paths: [], nodeId })

  // Effect paths admitted so far, across every declaration this build copies.
  let planEffectPaths = 0
  /**
   * Snapshots a declaration into graph-owned data, charging its paths to the
   * per-declaration and plan-wide limits. Both are checked before a path is
   * copied, so the copy never grows past the smaller remaining allowance.
   */
  const admitEffects = (
    declaration: Effects.Declaration | undefined,
    nodeId: string
  ): Effects.Declaration | undefined => {
    if (declaration === undefined) return undefined
    const effects = boundedEffects(
      declaration,
      Math.min(maximumEffectPaths, maximumPlanEffectPaths - planEffectPaths),
      () => planTooLarge(nodeId)
    )
    planEffectPaths += effects.reads.length + effects.writes.length
    return effects
  }

  // An envelope is graph-owned and reaches every node it encloses as the same
  // object, so it is prepared once and each enclosed declaration is checked
  // against the prepared form: a wide envelope costs its size once per build
  // rather than once per node that narrows it.
  const preparedEnvelopes = new Map<Effects.Declaration, EffectIndex.PreparedEnvelope>()
  const narrowAgainst = (envelope: Effects.Declaration, step: Effects.Declaration): Effects.NarrowResult => {
    let prepared = preparedEnvelopes.get(envelope)
    if (prepared === undefined) {
      prepared = EffectIndex.prepareEnvelope(envelope)
      preparedEnvelopes.set(envelope, prepared)
    }
    return EffectIndex.narrowPrepared(prepared, step)
  }

  const recordNode = (node: InternalNode): void => {
    if (observed.length >= maximumGraphNodes) throw planTooLarge(node.id)
    observed.push(node)
  }

  const recordEdge = (edge: InternalEdge): void => {
    if (observedEdges.length >= maximumGraphEdges) throw planTooLarge(edge.to)
    const index = observedEdges.push(edge) - 1
    const targets = outgoing.get(edge.from)
    if (targets === undefined) {
      outgoing.set(edge.from, [{ to: edge.to, index }])
    } else {
      targets.push({ to: edge.to, index })
    }
  }

  const resolveLayers = (request: LayerRequest): ReadonlyArray<string> =>
    [...new Set(options.resolveLayers?.(request) ?? [])].sort()

  const visit = (
    ast: NodeAst,
    id: string,
    parentAnnotations: Context.Context<never>,
    capabilities: ReadonlyArray<string> | undefined,
    envelope: Effects.Declaration | undefined,
    depth = 0,
    callInput: unknown | typeof noInput = noInput,
    prerequisites: ReadonlyArray<{ readonly from: string; readonly reason: EdgeReason }> = []
  ): VisitResult => {
    if (depth > maximumGraphDepth) {
      throw new GraphBuildError({ code: "plan_too_deep", paths: [], nodeId: id })
    }
    ast = validateNodeAst(ast, id)
    const annotations = Annotations.merge(parentAnnotations, ast.annotations)
    const projection = annotationProjection(annotations, admitEffects(option(annotations, Annotations.Effects), id))
    const targetFlow = ast._tag === "FlowCall" ? internal.flow(ast) : undefined
    const flow = Flow.isFlow(targetFlow)
      ? targetFlow as FlowDetails
      : undefined
    // The declaration the AST itself carries: a dynamic node's own envelope or
    // the called flow's. It is admitted even when an annotation overrides it,
    // because it still reaches key material and, for a flow call, the body's
    // envelope.
    const ownEffects = ast._tag === "Dynamic"
      ? admitEffects(ast.effects, id)
      : ast._tag === "FlowCall"
      ? admitEffects(flow?.effects, id)
      : undefined
    const declaredEffects = projection.effects ?? ownEffects
    const work = ast._tag === "Dynamic"
    const effectiveEffects = work ? declaredEffects ?? admitEffects(envelope, id) : undefined
    const identityEffects = work ? effectiveEffects : projection.effects
    const dependencies: Array<string> = []
    const continuationDependencies = new Set<string>()
    const effectiveCallInput = ast._tag === "FlowCall" ? ast.input : callInput
    const normalizedGrant = capabilities === undefined ? undefined : [...new Set(capabilities)].sort()
    const recordedCapabilities = normalizedGrant ?? []
    const current: InternalNode = {
      id,
      kind: ast._tag,
      dependencies,
      declaredEffects,
      effectiveEffects,
      placement: projection.placement,
      lane: projection.lane,
      priority: projection.priority,
      capabilities: recordedCapabilities,
      annotations: projection,
      keyMaterial: undefined
    }
    recordNode(current)
    if (work) workNodes.add(current)

    const depend = (from: string, reason: EdgeReason): void => {
      dependencies.push(from)
      if (reason === "continuation") continuationDependencies.add(from)
      recordEdge({ from, to: id, reason })
    }
    for (const prerequisite of prerequisites) {
      depend(prerequisite.from, prerequisite.reason)
    }

    const narrowedEnvelope = declaredEffects ?? envelope
    const childAnnotations = withoutEffects(annotations)
    switch (ast._tag) {
      case "Succeed":
      case "Fail":
        break
      case "All": {
        for (const key of Object.keys(ast.nodes).sort()) {
          const child = visit(
            ast.nodes[key]!,
            `${id}.all.${key}`,
            childAnnotations,
            normalizedGrant,
            narrowedEnvelope,
            depth + 1
          )
          depend(child.id, "value")
        }
        break
      }
      case "Map": {
        const first = visit(
          ast.first,
          `${id}.map`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1
        )
        depend(first.id, "value")
        break
      }
      case "AndThen": {
        const first = visit(
          ast.first,
          `${id}.andThen`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1
        )
        const next = ast.next ?? (() => {
          const continuation = internal.operation(ast)
          if (continuation === undefined) {
            throw new Node.NodeBuildError({
              code: "invalid_continuation",
              member: id,
              message: `Node.andThen at "${id}" has no continuation builder`
            })
          }
          const result = continuation(plannedValue(first.id))
          if (!Node.isNode(result)) {
            throw new Node.NodeBuildError({
              code: "invalid_continuation",
              member: id,
              message: `Node.andThen at "${id}" must return a Node`
            })
          }
          return nodeAst(result, `${id}.then`)
        })()
        {
          const continuation = visit(
            next,
            `${id}.then`,
            childAnnotations,
            normalizedGrant,
            narrowedEnvelope,
            depth + 1,
            noInput,
            [{ from: first.id, reason: "continuation" }]
          )
          depend(continuation.id, "value")
        }
        break
      }
      case "Catch": {
        const first = visit(
          ast.first,
          `${id}.catch`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1
        )
        depend(first.id, "value")
        const handler = internal.operation(ast)
        if (handler === undefined) {
          throw new Node.NodeBuildError({
            code: "invalid_continuation",
            member: id,
            message: `Node.catch at "${id}" has no recovery builder`
          })
        }
        const arm = handler(plannedValue(first.id))
        if (!Node.isNode(arm)) {
          throw new Node.NodeBuildError({
            code: "invalid_continuation",
            member: id,
            message: `Node.catch at "${id}" must return a Node`
          })
        }
        const recovery = visit(
          nodeAst(arm, `${id}.recover`),
          `${id}.recover`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1,
          noInput,
          [{ from: first.id, reason: "continuation" }]
        )
        depend(recovery.id, "value")
        break
      }
      case "FlowCall": {
        const flowCapabilities = flow === undefined ? [] : [...new Set(flow.capabilities)].sort()
        const dropped = normalizedGrant === undefined
          ? []
          : flowCapabilities.filter((capability) => !normalizedGrant.includes(capability))
        if (dropped.length > 0) {
          observedDiagnostics.push(
            new GraphBuildError({
              code: "capability_outside_grant",
              paths: dropped,
              nodeId: id
            })
          )
        }
        if (flow?.body !== undefined) {
          const body = flow.body(ast.input)
          const flowAnnotations = withoutEffects(Annotations.merge(childAnnotations, flow.annotations))
          const child = visit(
            nodeAst(body, `${id}.flow`),
            `${id}.flow`,
            flowAnnotations,
            normalizedGrant === undefined
              ? flowCapabilities
              : normalizedGrant.filter((capability) => flowCapabilities.includes(capability)),
            ownEffects ?? narrowedEnvelope,
            depth + 1,
            ast.input
          )
          depend(child.id, "value")
        }
        break
      }
    }

    if (envelope !== undefined && declaredEffects !== undefined) {
      const narrowed = narrowAgainst(envelope, declaredEffects)
      if (!narrowed.ok) {
        observedDiagnostics.push(new GraphBuildError({ code: narrowed.code, paths: [...narrowed.paths], nodeId: id }))
      }
    }

    const inputs: Array<KeyMaterial.InputRef> = []
    if (effectiveCallInput !== noInput) {
      inputs.push({ _tag: "Literal", value: reflection(effectiveCallInput, id) })
      const seenRefs = new Set<string>()
      for (const ref of plannedInputRefs(effectiveCallInput, id)) {
        const identity = `${ref.from}\u0000${ref.path.join("\u0000")}`
        if (seenRefs.has(identity)) continue
        seenRefs.add(identity)
        inputs.push(ref)
      }
    }
    for (const dependency of dependencies) {
      inputs.push(
        continuationDependencies.has(dependency)
          ? { _tag: "Pending", from: dependency }
          : { _tag: "Ref", from: dependency, path: [] }
      )
    }
    current.keyMaterial = {
      version: "flows/key-material/v2",
      kind: tier(identityEffects),
      body: declarationBody(ast, flow, id, ownEffects),
      inputs,
      layers: resolveLayers({
        nodeId: id,
        kind: ast._tag,
        model: ast._tag === "Dynamic" ? ast.model : undefined,
        capabilities: recordedCapabilities,
        effects: identityEffects,
        placement: projection.placement
      }),
      capabilities: recordedCapabilities,
      effects: identityEffects,
      placement: projection.placement
    }
    return { id }
  }

  if (Flow.isFlow(flowOrNode)) {
    const flow = flowOrNode as FlowDetails
    if (flow.body === undefined) {
      throw new Flow.FlowError({
        code: "missing_body",
        message: flow.name === undefined
          ? "Cannot build a flow without a body"
          : `Cannot build flow "${flow.name}" without a body`
      })
    }
    visit(
      nodeAst(flow.body(input), "root"),
      "root",
      flow.annotations,
      flow.capabilities,
      admitEffects(flow.effects, "root"),
      0,
      input
    )
  } else {
    visit(nodeAst(flowOrNode, "root"), "root", Annotations.empty, undefined, undefined)
  }

  const visitedNodeIds = new Set<string>()
  const duplicateNodeIds = new Set<string>()
  for (const node of observed) {
    if (visitedNodeIds.has(node.id) && !duplicateNodeIds.has(node.id)) {
      duplicateNodeIds.add(node.id)
      observedDiagnostics.push(new GraphBuildError({ code: "duplicate_node_id", paths: [], nodeId: node.id }))
    }
    visitedNodeIds.add(node.id)
  }

  const nodeById = new Map(observed.map((node) => [node.id, node]))
  const addDependency = (to: InternalNode, from: string, reason: EdgeReason): void => {
    /* v8 ignore next -- the conflict pass skips a pair once an edge makes one reachable from the other, so a repeat arrives only from a caller added later */
    if (to.dependencies.includes(from)) return
    to.dependencies.push(from)
    recordEdge({ from, to: to.id, reason })
    /* v8 ignore next 6 -- every visited node and every lane merge is given key material before this pass runs; the guard records the invariant instead of silently dropping the edge from identity if that ever changes */
    if (to.keyMaterial === undefined) {
      observedDiagnostics.push(
        new GraphBuildError({ code: "missing_key_material", paths: [], nodeId: to.id })
      )
      return
    }
    to.keyMaterial = {
      ...to.keyMaterial,
      inputs: [
        ...to.keyMaterial.inputs,
        { _tag: "Ref", from, path: [] }
      ]
    }
  }
  // Reachability is answered from a transitive closure over node ids, one bit
  // per id, computed once from the structural edges. Ids are structural, so
  // every edge points at an ancestor or at a continuation visited later and
  // the id graph is acyclic: a node's closure is the union of its targets'
  // closures, taken in depth-first postorder. A conflict edge added below
  // joins its target's closure into its source's in place. That keeps every
  // later query exact, because a work node visited later never reaches one
  // visited earlier, so the only closure a new edge changes is its source's,
  // and two nodes that share an id share that entry.
  const idIndex = new Map<string, number>()
  for (const node of observed) {
    if (!idIndex.has(node.id)) idIndex.set(node.id, idIndex.size)
  }
  const ids = [...idIndex.keys()]
  const reachWords = Math.ceil(ids.length / 32)
  const reach = new Uint32Array(ids.length * reachWords)
  const joinClosure = (from: number, to: number): void => {
    const source = from * reachWords
    const target = to * reachWords
    for (let word = 0; word < reachWords; word++) {
      reach[source + word] = reach[source + word]! | reach[target + word]!
    }
    reach[source + (to >>> 5)] = reach[source + (to >>> 5)]! | (1 << (to & 31))
  }
  const reachable = (from: number, to: number): boolean =>
    (reach[from * reachWords + (to >>> 5)]! & (1 << (to & 31))) !== 0
  {
    const targets = ids.map((id) => edgesFrom(id).map((edge) => idIndex.get(edge.to)!))
    const state = new Uint8Array(ids.length)
    const stack: Array<number> = []
    const cursor: Array<number> = []
    for (let start = 0; start < ids.length; start++) {
      if (state[start] !== 0) continue
      state[start] = 1
      stack.push(start)
      cursor.push(0)
      while (stack.length > 0) {
        const top = stack.length - 1
        const current = stack[top]!
        const next = cursor[top]!
        if (next < targets[current]!.length) {
          cursor[top] = next + 1
          const target = targets[current]![next]!
          if (state[target] === 0) {
            state[target] = 1
            stack.push(target)
            cursor.push(0)
          }
          continue
        }
        state[current] = 2
        for (const target of targets[current]!) joinClosure(current, target)
        stack.pop()
        cursor.pop()
      }
    }
  }

  const conflicts: Array<Conflict> = []
  const laneConflicts: Array<{
    readonly conflictIndex: number
    readonly left: InternalNode
    readonly right: InternalNode
    readonly paths: ReadonlyArray<string>
  }> = []
  const work = observed.filter(
    (node): node is InternalNode & { effectiveEffects: Effects.Declaration } =>
      workNodes.has(node) && node.effectiveEffects !== undefined
  )
  // Every pair that can overlap is found from one index of every writer's
  // write paths. Two writers naming the same string share that path's bucket,
  // and a writer's covering pattern enumerates the ranks under its prefix and
  // the writers holding them, so the work is the index plus one step per
  // (pattern, covered path, holder) triple rather than one comparison per
  // pair of writers. A pair is marked once, in a bitset row per earlier
  // writer, so the pairs are visited in the order of the plain nested loop
  // and conflict indices and edges do not move. Only a marked pair overlaps,
  // and a marked pair that is not already ordered always does, so the overlap
  // itself is computed at most once per recorded conflict.
  const writers = work.length
  const indexed = EffectIndex.indexPaths(work.map((node) => node.effectiveEffects.writes))
  const ranked = work.map((node) => EffectIndex.rankPaths(indexed, node.effectiveEffects.writes))
  const rankCount = indexed.paths.length
  // The writers holding each rank, ascending, in compressed-row form.
  const bucketStart = new Int32Array(rankCount + 1)
  for (const { ranks } of ranked) {
    for (const rank of ranks) bucketStart[rank + 1] = bucketStart[rank + 1]! + 1
  }
  for (let rank = 0; rank < rankCount; rank++) {
    bucketStart[rank + 1] = bucketStart[rank + 1]! + bucketStart[rank]!
  }
  const bucket = new Int32Array(bucketStart[rankCount]!)
  const fill = bucketStart.slice(0, rankCount)
  ranked.forEach(({ ranks }, writer) => {
    for (const rank of ranks) {
      const at = fill[rank]!
      bucket[at] = writer
      fill[rank] = at + 1
    }
  })
  const pairWords = Math.ceil(writers / 32)
  const pairs = new Uint32Array(writers * pairWords)
  const mark = (left: number, right: number): void => {
    const position = left * pairWords + (right >>> 5)
    pairs[position] = pairs[position]! | (1 << (right & 31))
  }
  for (let rank = 0; rank < rankCount; rank++) {
    const end = bucketStart[rank + 1]!
    for (let first = bucketStart[rank]!; first < end; first++) {
      for (let second = first + 1; second < end; second++) mark(bucket[first]!, bucket[second]!)
    }
  }
  ranked.forEach(({ globs }, writer) => {
    for (const glob of globs) {
      const high = indexed.high[glob]!
      for (let rank = indexed.low[glob]!; rank < high; rank++) {
        if (indexed.dotted[rank] === 1) continue
        const end = bucketStart[rank + 1]!
        for (let position = bucketStart[rank]!; position < end; position++) {
          const holder = bucket[position]!
          if (holder < writer) {
            mark(holder, writer)
          } else if (holder > writer) {
            mark(writer, holder)
          }
        }
      }
    }
  })
  for (let left = 0; left < writers; left++) {
    const a = work[left]!
    const aId = idIndex.get(a.id)!
    const row = left * pairWords
    for (let word = 0; word < pairWords; word++) {
      let bits = pairs[row + word]!
      while (bits !== 0) {
        const lowest = bits & -bits
        bits ^= lowest
        const right = word * 32 + 31 - Math.clz32(lowest)
        const b = work[right]!
        const bId = idIndex.get(b.id)!
        if (aId === bId || reachable(aId, bId) || reachable(bId, aId)) continue
        if (conflicts.length >= maximumGraphConflicts) throw planTooLarge(b.id)
        const paths = EffectIndex.overlapRanks(indexed, ranked[left]!, ranked[right]!)
          .map((rank) => indexed.paths[rank]!)
        const aEffects = a.effectiveEffects
        const bEffects = b.effectiveEffects
        const selected = strategy(aEffects, bEffects)
        conflicts.push({ nodes: [a.id, b.id], paths, strategy: selected })
        if (selected === "fail") {
          observedDiagnostics.push(
            new GraphBuildError({ code: "write_conflict", paths: [...paths], nodes: [a.id, b.id] })
          )
        }
        if (selected === "serialize") {
          addDependency(b, a.id, "conflict")
          joinClosure(aId, bId)
        }
        if (selected === "lane") {
          for (const node of [a, b]) {
            if (node.lane !== undefined) continue
            const lane = { id: `lane:${node.id}` }
            node.lane = lane
            node.annotations = { ...node.annotations, lane }
          }
          laneConflicts.push({
            conflictIndex: conflicts.length - 1,
            left: a,
            right: b,
            paths
          })
        }
      }
    }
  }

  for (let index = 0; index < laneConflicts.length; index++) {
    const laneConflict = laneConflicts[index]!
    const mergeId = `lane.merge.${index}`
    // Sorted by edge position so consumers keep the order a scan of
    // `observedEdges` would give them, which key material observes.
    const consumers = new Set(
      [...edgesFrom(laneConflict.left.id), ...edgesFrom(laneConflict.right.id)]
        .sort((first, second) => first.index - second.index)
        .map((edge) => edge.to)
    )
    const capabilities = [
      ...new Set([
        ...laneConflict.left.capabilities,
        ...laneConflict.right.capabilities
      ])
    ].sort()
    const mergeEffects = admitEffects(
      Effects.make({
        reads: laneConflict.paths,
        writes: laneConflict.paths,
        mode: "hermetic",
        onConflict: "serialize",
        tier: "compensable"
      }),
      mergeId
    )!
    const leftPlacement = reflection(laneConflict.left.placement, mergeId)
    const rightPlacement = reflection(laneConflict.right.placement, mergeId)
    const placement = JSON.stringify(leftPlacement) === JSON.stringify(rightPlacement)
      ? laneConflict.left.placement
      : undefined
    const mergeNode: InternalNode = {
      id: mergeId,
      kind: "LaneMerge",
      dependencies: [laneConflict.left.id, laneConflict.right.id],
      declaredEffects: mergeEffects,
      effectiveEffects: mergeEffects,
      placement,
      lane: undefined,
      priority: undefined,
      capabilities,
      annotations: {
        placement,
        effects: mergeEffects,
        lane: undefined,
        priority: undefined
      },
      keyMaterial: {
        version: "flows/key-material/v2",
        kind: "compensable",
        body: { _tag: "LaneMerge", paths: laneConflict.paths },
        inputs: [
          { _tag: "Ref", from: laneConflict.left.id, path: [] },
          { _tag: "Ref", from: laneConflict.right.id, path: [] }
        ],
        layers: resolveLayers({
          nodeId: mergeId,
          kind: "LaneMerge",
          model: undefined,
          capabilities,
          effects: mergeEffects,
          placement
        }),
        capabilities,
        effects: mergeEffects,
        placement
      }
    }
    recordNode(mergeNode)
    nodeById.set(mergeId, mergeNode)
    recordEdge({ from: laneConflict.left.id, to: mergeId, reason: "lane-merge" })
    recordEdge({ from: laneConflict.right.id, to: mergeId, reason: "lane-merge" })
    for (const consumerId of consumers) {
      const consumer = nodeById.get(consumerId)
      /* v8 ignore else -- every edge target is a node this build recorded, so the lookup only misses if a later pass invents an edge */
      if (consumer !== undefined) addDependency(consumer, mergeId, "lane-merge")
    }
    conflicts[laneConflict.conflictIndex] = {
      ...conflicts[laneConflict.conflictIndex]!,
      mergeNodeId: mergeId
    }
  }

  return freezeGraph({ nodes: observed, edges: observedEdges, diagnostics: observedDiagnostics, conflicts })
}

/**
 * Returns graph nodes in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const nodes = (graph: Graph): ReadonlyArray<GraphNode> => graph.nodes as ReadonlyArray<GraphNode>

/**
 * Returns graph dependency edges in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const edges = (graph: Graph): ReadonlyArray<Edge> => graph.edges

/**
 * Returns declared and inherited effect data for nodes that carry either.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const effects = (graph: Graph): ReadonlyArray<EffectEntry> =>
  graph.nodes
    .filter((node) => node.declaredEffects !== undefined || node.effectiveEffects !== undefined)
    .map((node) => ({
      nodeId: node.id,
      declared: node.declaredEffects,
      effective: node.effectiveEffects
    }))

/**
 * Returns resolved placement data in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const placements = (graph: Graph): ReadonlyArray<PlacementEntry> =>
  graph.nodes.flatMap((node) => node.placement === undefined ? [] : [{ nodeId: node.id, placement: node.placement }])

/**
 * Returns overlapping-write conflict data.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const conflicts = (graph: Graph): ReadonlyArray<Conflict> => graph.conflicts

/**
 * Returns build diagnostics without throwing.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const diagnostics = (graph: Graph): ReadonlyArray<GraphBuildError> => graph.diagnostics

/**
 * Returns node-associated, digest-free key material in topological dependency
 * order. The graph-local node id is outside the material that `/keys`
 * hashes.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const keyMaterial = (
  graph: Graph
): Result.Result<ReadonlyArray<KeyMaterial.Entry>, GraphBuildError> => {
  for (const diagnostic of graph.diagnostics) {
    if (isFatalDiagnostic(diagnostic)) return Result.fail(diagnostic)
  }
  const ordered: Array<KeyMaterial.Entry> = []
  const visited = new Set<string>()
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const visit = (node: InternalNode): GraphBuildError | undefined => {
    if (visited.has(node.id)) return undefined
    visited.add(node.id)
    for (const dependency of node.dependencies) {
      const child = byId.get(dependency)
      if (child !== undefined) {
        const failure = visit(child)
        if (failure !== undefined) return failure
      }
    }
    if (node.keyMaterial === undefined) {
      return new GraphBuildError({ code: "missing_key_material", paths: [], nodeId: node.id })
    }
    ordered.push({ nodeId: node.id, material: node.keyMaterial })
    return undefined
  }
  for (const node of graph.nodes) {
    const failure = visit(node)
    if (failure !== undefined) return Result.fail(failure)
  }
  return Result.succeed(ordered)
}
