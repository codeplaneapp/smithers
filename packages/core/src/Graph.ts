/**
 * Pure graph introspection for flow declarations.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Flow Builder Brief.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Vendored Flow Engine.md`.
 *
 * @since 0.0.0
 */
import { Context, Option, Result, Schema } from "effect"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import * as Flow from "./Flow.ts"
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

type EdgeReason = "value" | "continuation" | "conflict" | "lane-merge"

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
  "write_conflict"
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
 * A graph-build diagnostic. Graph construction records these values instead of
 * throwing, so inspection remains possible for invalid declarations.
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

/**
 * @since 0.0.0
 * @private
 */
interface GraphImpl {
  readonly nodes: ReadonlyArray<InternalNode>
  readonly edges: ReadonlyArray<InternalEdge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
  readonly conflicts: ReadonlyArray<Conflict>
}

/**
 * An immutable, observation-only flow graph.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Graph = GraphImpl

const option = <I, S>(context: Context.Context<never>, key: Context.Key<I, S>): S | undefined =>
  Option.getOrUndefined(Annotations.getOption(context, key))

const annotationProjection = (context: Context.Context<never>): AnnotationsProjection => ({
  placement: option(context, Annotations.Placement),
  effects: option(context, Annotations.Effects),
  lane: option(context, Annotations.Lane),
  priority: option(context, Annotations.Priority)
})

const withoutEffects = (context: Context.Context<never>): Context.Context<never> =>
  Context.omit(Annotations.Effects)(context)

const tier = (effects: Effects.Declaration | undefined): KeyMaterial.KeyMaterial["kind"] => effects?.tier ?? "sealed"

const schemaIdentity = (schema: Schema.Top): unknown => {
  try {
    return {
      _tag: "Schema",
      document: Schema.toJsonSchemaDocument(schema)
    }
  } catch {
    return {
      _tag: "Schema",
      ast: schema.ast._tag
    }
  }
}

const plannedDescriptor = (value: unknown): PlannedValueDescriptor | undefined => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined
  return (value as { readonly [PlannedValueTypeId]?: PlannedValueDescriptor })[PlannedValueTypeId]
}

const plannedValue = (from: string, path: ReadonlyArray<string> = []): unknown => {
  const target = (): undefined => undefined
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

const plannedInputRefs = (
  value: unknown,
  seen: Set<object> = new Set()
): ReadonlyArray<KeyMaterial.InputRef> => {
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return [{ _tag: "Ref", from: descriptor.from, path: descriptor.path }]
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return []
  if (seen.has(value)) return []
  seen.add(value)
  const refs: Array<KeyMaterial.InputRef> = []
  if (Array.isArray(value)) {
    for (const item of value) refs.push(...plannedInputRefs(item, seen))
  } else {
    for (const key of Object.keys(value).sort()) {
      refs.push(...plannedInputRefs(value[key as keyof typeof value], seen))
    }
  }
  seen.delete(value)
  return refs
}

const reflection = (value: unknown, seen: Set<object> = new Set()): unknown => {
  const descriptor = plannedDescriptor(value)
  if (descriptor !== undefined) {
    return {
      _tag: "PlannedInput",
      path: descriptor.path
    }
  }
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "bigint") return { _tag: "BigInt", value: String(value) }
  if (typeof value === "symbol") return { _tag: "Symbol", value: value.description }
  if (Flow.isFlow(value)) {
    if (seen.has(value)) return { _tag: "CircularFlow" }
    seen.add(value)
    const flow = value as FlowDetails
    const result = {
      _tag: "Flow",
      input: schemaIdentity(flow.input),
      output: schemaIdentity(flow.output),
      capabilities: [...new Set(flow.capabilities)].sort(),
      effects: flow.effects,
      implementation: reflection(flow.implementation, seen)
    }
    seen.delete(value)
    return result
  }
  if (Schema.isSchema(value)) return schemaIdentity(value)
  if (typeof value === "function") return { _tag: "Function" }
  if (seen.has(value)) return { _tag: "Circular" }
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((item) => reflection(item, seen))
    seen.delete(value)
    return result
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = reflection(value[key as keyof typeof value], seen)
  }
  seen.delete(value)
  return result
}

const declarationBody = (
  ast: NodeAst,
  flow: FlowDetails | undefined
): unknown => {
  switch (ast._tag) {
    case "Succeed":
      return { _tag: ast._tag, value: reflection(ast.value) }
    case "Fail":
      return { _tag: ast._tag, error: reflection(ast.error) }
    case "All":
      return { _tag: ast._tag, keys: Object.keys(ast.nodes) }
    case "Dynamic":
      return {
        _tag: ast._tag,
        model: ast.model,
        flows: reflection(ast.flows),
        output: reflection(ast.output),
        prompt: ast.prompt,
        effects: ast.effects
      }
    case "FlowCall":
      return {
        _tag: ast._tag,
        input: flow === undefined ? undefined : schemaIdentity(flow.input),
        output: flow === undefined ? undefined : schemaIdentity(flow.output),
        capabilities: flow?.capabilities === undefined ? undefined : [...new Set(flow.capabilities)].sort(),
        effects: flow?.effects,
        implementation: reflection(flow?.implementation)
      }
    case "Map":
      return { _tag: ast._tag, mapper: ast.mapper }
    case "AndThen":
      return { _tag: ast._tag, continuation: ast.continuation, static: ast.next !== undefined }
    case "Catch":
      return {
        _tag: ast._tag,
        handler: ast.handler,
        error: ast.error === undefined ? undefined : schemaIdentity(ast.error as Schema.Top)
      }
  }
}

const strategy = (left: Effects.Declaration, right: Effects.Declaration): Conflict["strategy"] => {
  if (left.onConflict === "fail" || right.onConflict === "fail") return "fail"
  if (left.onConflict === "lane" || right.onConflict === "lane") return "lane"
  return "serialize"
}

/**
 * Builds a graph by evaluating declared flow bodies and pure `Node.andThen`
 * builders exactly once against symbolic predecessor values. This reveals the
 * complete static topology without running a node, an Effect, a `Node.map`
 * value transformation, or a dynamic elaboration.
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

  const resolveLayers = (request: LayerRequest): ReadonlyArray<string> =>
    [...new Set(options.resolveLayers?.(request) ?? [])].sort()

  const visit = (
    ast: NodeAst,
    id: string,
    parentAnnotations: Context.Context<never>,
    capabilities: ReadonlyArray<string>,
    envelope: Effects.Declaration | undefined,
    callInput: unknown | typeof noInput = noInput,
    prerequisites: ReadonlyArray<{ readonly from: string; readonly reason: EdgeReason }> = []
  ): VisitResult => {
    const annotations = Annotations.merge(parentAnnotations, ast.annotations)
    const projection = annotationProjection(annotations)
    const targetFlow = ast._tag === "FlowCall" ? internal.flow(ast) : undefined
    const flow = Flow.isFlow(targetFlow)
      ? targetFlow as FlowDetails
      : undefined
    const declaredEffects = projection.effects ?? (ast._tag === "Dynamic" ? ast.effects : undefined) ??
      (ast._tag === "FlowCall" ? flow?.effects : undefined)
    const work = ast._tag === "Dynamic"
    const effectiveEffects = work ? declaredEffects ?? envelope : undefined
    const dependencies: Array<string> = []
    const continuationDependencies = new Set<string>()
    const effectiveCallInput = ast._tag === "FlowCall" ? ast.input : callInput
    const normalizedCapabilities = [...new Set(capabilities)].sort()
    const current: InternalNode = {
      id,
      kind: ast._tag,
      dependencies,
      declaredEffects,
      effectiveEffects,
      placement: projection.placement,
      lane: projection.lane,
      priority: projection.priority,
      capabilities: normalizedCapabilities,
      annotations: projection,
      keyMaterial: undefined
    }
    observed.push(current)
    if (work) workNodes.add(current)

    const depend = (from: string, reason: EdgeReason): void => {
      dependencies.push(from)
      if (reason === "continuation") continuationDependencies.add(from)
      observedEdges.push({ from, to: id, reason })
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
        for (const key of Object.keys(ast.nodes)) {
          const child = visit(
            ast.nodes[key]!,
            `${id}.all.${key}`,
            childAnnotations,
            normalizedCapabilities,
            narrowedEnvelope
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
          normalizedCapabilities,
          narrowedEnvelope
        )
        depend(first.id, "value")
        break
      }
      case "AndThen": {
        const first = visit(
          ast.first,
          `${id}.andThen`,
          childAnnotations,
          normalizedCapabilities,
          narrowedEnvelope
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
          return result.ast
        })()
        {
          const continuation = visit(
            next,
            `${id}.then`,
            childAnnotations,
            normalizedCapabilities,
            narrowedEnvelope,
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
          normalizedCapabilities,
          narrowedEnvelope
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
          arm.ast,
          `${id}.recover`,
          childAnnotations,
          normalizedCapabilities,
          narrowedEnvelope,
          noInput,
          [{ from: first.id, reason: "continuation" }]
        )
        depend(recovery.id, "value")
        break
      }
      case "FlowCall": {
        if (flow?.body !== undefined) {
          const body = flow.body(ast.input)
          const flowAnnotations = withoutEffects(Annotations.merge(childAnnotations, flow.annotations))
          const child = visit(
            body.ast,
            `${id}.flow`,
            flowAnnotations,
            normalizedCapabilities.filter((capability) => flow.capabilities.includes(capability)),
            flow.effects ?? narrowedEnvelope,
            ast.input
          )
          depend(child.id, "value")
        }
        break
      }
    }

    if (envelope !== undefined && declaredEffects !== undefined) {
      const narrowed = Effects.narrow(envelope, declaredEffects)
      if (!narrowed.ok) {
        observedDiagnostics.push(new GraphBuildError({ code: narrowed.code, paths: [...narrowed.paths] }))
      }
    }

    const inputs: Array<KeyMaterial.InputRef> = []
    if (effectiveCallInput !== noInput) {
      inputs.push({ _tag: "Literal", value: reflection(effectiveCallInput) })
      const seenRefs = new Set<string>()
      for (const ref of plannedInputRefs(effectiveCallInput)) {
        if (ref._tag !== "Ref") continue
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
      version: "flows/key-material/v1",
      kind: tier(effectiveEffects),
      body: declarationBody(ast, flow),
      inputs,
      layers: resolveLayers({
        nodeId: id,
        kind: ast._tag,
        model: ast._tag === "Dynamic" ? ast.model : undefined,
        capabilities: normalizedCapabilities,
        effects: effectiveEffects,
        placement: projection.placement
      }),
      capabilities: normalizedCapabilities,
      effects: effectiveEffects,
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
    visit(flow.body(input).ast, "root", flow.annotations, flow.capabilities, flow.effects, input)
  } else {
    visit(flowOrNode.ast, "root", Annotations.empty, [], undefined)
  }

  const nodeById = new Map(observed.map((node) => [node.id, node]))
  const addDependency = (to: InternalNode, from: string, reason: EdgeReason): void => {
    if (to.dependencies.includes(from)) return
    to.dependencies.push(from)
    observedEdges.push({ from, to: to.id, reason })
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
        reason === "continuation"
          ? { _tag: "Pending", from }
          : { _tag: "Ref", from, path: [] }
      ]
    }
  }
  const reachable = (from: string, to: string): boolean => {
    const pending = [from]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()!
      if (current === to) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const edge of observedEdges) {
        if (edge.from === current) pending.push(edge.to)
      }
    }
    return false
  }

  const conflicts: Array<Conflict> = []
  const laneConflicts: Array<{
    readonly conflictIndex: number
    readonly left: InternalNode
    readonly right: InternalNode
    readonly paths: ReadonlyArray<string>
  }> = []
  const work = observed.filter((node) => workNodes.has(node) && node.effectiveEffects !== undefined)
  for (let left = 0; left < work.length; left++) {
    const a = work[left]!
    for (let right = left + 1; right < work.length; right++) {
      const b = work[right]!
      const aEffects = a.effectiveEffects
      const bEffects = b.effectiveEffects
      if (aEffects === undefined || bEffects === undefined) continue
      if (reachable(a.id, b.id) || reachable(b.id, a.id)) continue
      const paths = Effects.overlaps(aEffects, bEffects)
      if (paths.length === 0) continue
      const selected = strategy(aEffects, bEffects)
      conflicts.push({ nodes: [a.id, b.id], paths, strategy: selected })
      if (selected === "fail") {
        observedDiagnostics.push(
          new GraphBuildError({ code: "write_conflict", paths: [...paths], nodes: [a.id, b.id] })
        )
      }
      if (selected === "serialize") {
        addDependency(b, a.id, "conflict")
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

  for (let index = 0; index < laneConflicts.length; index++) {
    const laneConflict = laneConflicts[index]!
    const mergeId = `lane.merge.${index}`
    const consumers = new Set(
      observedEdges
        .filter((edge) => edge.from === laneConflict.left.id || edge.from === laneConflict.right.id)
        .map((edge) => edge.to)
    )
    const capabilities = [
      ...new Set([
        ...laneConflict.left.capabilities,
        ...laneConflict.right.capabilities
      ])
    ].sort()
    const mergeEffects = Effects.make({
      reads: laneConflict.paths,
      writes: laneConflict.paths,
      mode: "hermetic",
      onConflict: "serialize",
      tier: "compensable"
    })
    const leftPlacement = reflection(laneConflict.left.placement)
    const rightPlacement = reflection(laneConflict.right.placement)
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
        version: "flows/key-material/v1",
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
    observed.push(mergeNode)
    nodeById.set(mergeId, mergeNode)
    observedEdges.push(
      { from: laneConflict.left.id, to: mergeId, reason: "lane-merge" },
      { from: laneConflict.right.id, to: mergeId, reason: "lane-merge" }
    )
    for (const consumerId of consumers) {
      const consumer = nodeById.get(consumerId)
      if (consumer !== undefined) addDependency(consumer, mergeId, "lane-merge")
    }
    conflicts[laneConflict.conflictIndex] = {
      ...conflicts[laneConflict.conflictIndex]!,
      mergeNodeId: mergeId
    }
  }

  return { nodes: observed, edges: observedEdges, diagnostics: observedDiagnostics, conflicts }
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
