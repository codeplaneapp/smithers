/**
 * Pure projection and presentation helpers for built plans.
 *
 * Keys are derived from the graph's digest-free key material through
 * `/keys` — sealed nodes get cross-run content keys, non-sealed nodes
 * get run-local ordinal keys. Plan projection is pure: it never touches Host,
 * Model, or Clock, and is expected to succeed under `TestLayers.poisoned`.
 *
 * @since 0.0.0
 */
import * as Digest from "@smthrs/core/Digest"
import type * as Flow from "@smthrs/core/Flow"
import * as CoreGraph from "@smthrs/core/Graph"
import type * as CorePlacement from "@smthrs/core/Placement"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { compare } from "./internal/Structural.ts"
import type { PlanLike, PlanNodeLike, PlanPlacementLike } from "./PlanLike.ts"

/**
 * A plan node with presentation-only collections in canonical order.
 *
 * @category models
 * @since 0.0.0
 */
export interface Node extends PlanNodeLike {
  readonly effects: ReadonlyArray<string>
}

/**
 * A built plan with presentation-only collections in canonical order.
 *
 * @category models
 * @since 0.0.0
 */
export interface Plan extends Omit<PlanLike, "nodes" | "edges"> {
  readonly nodes: ReadonlyArray<Node>
  readonly edges: ReadonlyArray<PlanLike["edges"][number]>
}

/**
 * Options for graph-local key derivation.
 *
 * @category models
 * @since 0.0.0
 */
export interface KeysOptions {
  /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
  readonly runId?: string | undefined
}

/**
 * Inputs needed to project a core graph into the testing assertion port.
 *
 * Keys are computed from each node's `keyMaterial` via `/keys` by
 * default. The `key` resolver remains available only as a test override for
 * fixtures that need synthetic keys.
 *
 * @category models
 * @since 0.0.0
 */
export interface FromGraphOptions {
  /** Test-only override; omit to derive real keys from graph key material. */
  readonly key?: ((node: CoreGraph.GraphNode) => string) | undefined
  /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
  readonly runId?: string | undefined
  readonly envelope?: Record<string, unknown> | undefined
  readonly digest?: string | undefined
}

/**
 * Options accepted by {@link planOf}.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanOfOptions extends FromGraphOptions {
  readonly build?: CoreGraph.BuildOptions | undefined
}

// Core's key material may carry values `/keys` canonicalization rejects
// (undefined properties, functions inside deferred continuations, tagged Data
// instances for placements). This mirrors core's own `reflection` convention:
// functions become `{ _tag: "Function" }`, undefined object properties are
// absent, and every object is rebuilt as a plain literal. It is a pure,
// deterministic normalization — no identity-bearing data is dropped.
const canonical = (value: unknown, seen: Set<object> = new Set()): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }
  if (value === undefined) return null
  if (typeof value === "bigint") return { _tag: "BigInt", value: String(value) }
  if (typeof value === "symbol") return { _tag: "Symbol", value: value.description ?? null }
  if (typeof value === "function") return { _tag: "Function" }
  if (seen.has(value)) return { _tag: "Circular" }
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonical(item, seen))
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => compare(left, right))) {
      if (item !== undefined) result[key] = canonical(item, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/**
 * Derives every node's step key from the graph's digest-free key material.
 *
 * Sealed material becomes a content key via `StepKey.fromKeyMaterial`, with
 * dependency references resolved to previously derived keys in topological
 * order. Non-sealed material becomes a run-local ordinal key.
 *
 * The compiler is `@smthrs/plan`'s — the revived `KeyMaterial` → `StepKey`
 * module that owns `Ref`/`Pending` substitution — so the keys asserted here are
 * the keys the persisted plan records. It hashes through the injected `Crypto`
 * service; `Digest.runSync` supplies the synchronous one so plan projection
 * stays pure and total under `TestLayers.poisoned`.
 *
 * @category constructors
 * @since 0.0.0
 */
export const keys = (graph: CoreGraph.Graph, options: KeysOptions = {}): Record<string, string> => {
  const runId = options.runId ?? "plan"
  const digests: Record<string, string> = {}
  Result.getOrThrow(CoreGraph.keyMaterial(graph)).forEach((entry, index) => {
    const material = entry.material
    digests[entry.nodeId] = Digest.runSync(
      material.kind === "sealed"
        ? StepKey.fromKeyMaterial(
          {
            ...material,
            body: canonical(material.body),
            inputs: material.inputs.map((input) =>
              input._tag === "Literal" ? { _tag: "Literal", value: canonical(input.value) } : input
            ),
            effects: material.effects === undefined
              ? undefined
              : canonical(material.effects) as typeof material.effects,
            placement: material.placement === undefined
              ? undefined
              : canonical(material.placement) as typeof material.placement
          },
          digests
        )
        : StepKey.ordinal({
          runId,
          parentScope: entry.nodeId,
          ordinal: index,
          tier: material.kind
        })
    )
  })
  return digests
}

const declaredEffects = (node: CoreGraph.GraphNode): ReadonlyArray<string> => {
  const declaration = node.declaredEffects
  return declaration === undefined
    ? []
    : [
      ...declaration.reads.map((path) => `read:${path}`),
      ...declaration.writes.map((path) => `write:${path}`)
    ].sort()
}

const placementProjection = (placement: CorePlacement.Placement): PlanPlacementLike => {
  const { _tag, ...rest } = placement as { readonly _tag: string } & Record<string, unknown>
  return {
    tag: _tag,
    options: Object.fromEntries(
      Object.entries(rest)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => compare(left, right))
    )
  }
}

/**
 * Projects the public `/core` graph introspection API into a PlanLike.
 *
 * @category constructors
 * @since 0.0.0
 */
export const fromGraph = (graph: CoreGraph.Graph, options: FromGraphOptions = {}): PlanLike => {
  const derived = options.key === undefined ? keys(graph, { runId: options.runId }) : undefined
  return {
    nodes: CoreGraph.nodes(graph).map((node): PlanNodeLike => {
      const declaration = node.declaredEffects ?? node.effectiveEffects
      return {
        id: node.id,
        key: options.key === undefined ? derived![node.id]! : options.key(node),
        kind: node.kind,
        ...(node.placement === undefined ? {} : { placement: placementProjection(node.placement) }),
        effects: declaredEffects(node),
        ...(declaration === undefined ? {} : {
          mode: declaration.mode,
          onConflict: declaration.onConflict,
          ...(declaration.tier === undefined ? {} : { tier: declaration.tier })
        }),
        sealed: node.keyMaterial.kind === "sealed",
        ...(node.effectiveEffects === undefined
          ? {}
          : { envelope: { ...node.effectiveEffects } })
      }
    }),
    edges: CoreGraph.edges(graph).map(({ from, to }) => ({ from, to })),
    ...(options.envelope === undefined ? {} : { envelope: options.envelope }),
    ...(options.digest === undefined ? {} : { digest: options.digest })
  }
}

/**
 * Decodes flow input through the flow's declared input schema, then builds
 * and projects the plan. Un-defaulted input cannot reach a plan: the schema's
 * defaults are applied by construction before planning sees the value.
 *
 * Building and projecting are pure — this succeeds under
 * `TestLayers.poisoned` and only ever fails on schema decoding.
 *
 * @category constructors
 * @since 0.0.0
 */
export const planOf = <F extends Flow.Any>(
  flow: F,
  input: unknown,
  options: PlanOfOptions = {}
): Effect.Effect<PlanLike, Schema.SchemaError, F["input"]["DecodingServices"]> =>
  Schema.decodeUnknownEffect(flow.input)(input).pipe(
    Effect.map((decoded) => fromGraph(CoreGraph.build(flow, decoded, options.build ?? {}), options))
  )

/**
 * Copies a built plan into a stable presentation order.
 *
 * Node ids, edge endpoints, keys, envelopes, and every other semantic field
 * are retained verbatim. This is intentionally not a graph traversal or a key
 * computation helper.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (plan: PlanLike): Plan => ({
  ...plan,
  nodes: plan.nodes
    .map((node) => ({ ...node, effects: [...node.effects].sort() }))
    .sort((left, right) => compare(left.id, right.id)),
  edges: [...plan.edges].sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to))
})

const stable = (value: unknown): string => JSON.stringify(canonical(value))

/**
 * Renders a plan as a stable, line-oriented canonical string.
 *
 * Nodes and edges appear in the deterministic order of {@link make}; object
 * payloads render with sorted keys. Byte-identical output for semantically
 * identical plans makes this the substrate for snapshot assertions.
 *
 * @category formatting
 * @since 0.0.0
 */
export const render = (plan: PlanLike): string => {
  const ordered = make(plan)
  const lines: Array<string> = []
  if (ordered.digest !== undefined) lines.push(`digest ${ordered.digest}`)
  if (ordered.envelope !== undefined) lines.push(`envelope ${stable(ordered.envelope)}`)
  for (const item of ordered.nodes) {
    const parts = [`node ${item.id}`, `key=${item.key}`, `kind=${item.kind}`]
    if (item.placement !== undefined) {
      const options = Object.keys(item.placement.options).length === 0 ? "" : stable(item.placement.options)
      parts.push(`placement=${item.placement.tag}${options}`)
    }
    if (item.mode !== undefined) parts.push(`mode=${item.mode}`)
    if (item.tier !== undefined) parts.push(`tier=${item.tier}`)
    if (item.onConflict !== undefined) parts.push(`onConflict=${item.onConflict}`)
    parts.push(`sealed=${item.sealed}`)
    parts.push(`effects=[${[...item.effects].sort().join(",")}]`)
    if (item.envelope !== undefined) parts.push(`envelope=${stable(item.envelope)}`)
    lines.push(parts.join(" "))
  }
  for (const value of ordered.edges) lines.push(`edge ${value.from} -> ${value.to}`)
  return lines.join("\n")
}

/**
 * Returns the built node with the supplied id, if present.
 *
 * @category getters
 * @since 0.0.0
 */
export const node = (plan: PlanLike, id: string): PlanNodeLike | undefined =>
  plan.nodes.find((candidate) => candidate.id === id)

/**
 * Renders an edge as a stable, readable pair.
 *
 * @category formatting
 * @since 0.0.0
 */
export const edge = (value: PlanLike["edges"][number]): string => `${value.from} -> ${value.to}`
